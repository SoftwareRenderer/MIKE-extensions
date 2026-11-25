// The frame's wiring, tested without a browser: a stub DOM, a stub host and a stub renderer, then the real
// stl-preview.js over the real stl-parse.js and real STL bytes. It pins down what the parser test cannot reach
// — which sides the frame asks the host for, how many panes it builds, what it says under them, that it asks for
// a height — and cannot show that three.js drew anything; that is the person pressing Try Extension, so this
// needs node on the path (tests/README.md: the default image has neither node nor a browser).

//   node tests/frame-stl.mjs        exits non-zero on the first failure
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, '..', name), 'utf8');
const PARSE_SRC = read('stl-parse.js');
const RENDER_SRC = read('stl-render.js');
const PREVIEW_SRC = read('stl-preview.js');

let failed = 0;
function check(name, condition, detail) {
    if (condition) console.log('ok   ' + name);
    else { failed += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' (' + detail + ')')); }
}
const near = (a, b, epsilon = 1e-4) => a !== null && Math.abs(a - b) <= epsilon;

function node(tag) {
    const self = {
        tagName: tag,
        children: [],
        className: '',
        id: '',
        clientWidth: 300,
        clientHeight: 200,
        style: {},
        attributes: {},
        listeners: {},
        classList: { add() {}, remove() {}, contains: () => false },
        // The frame empties a container with `textContent = ''`, which in a real DOM drops its
        // children — a stub that kept them would let a rebuilt toolbar pass while showing two of them.
        set textContent(value) { self._text = String(value); if (self.children.length) self.children.length = 0; },
        get textContent() { return self._text; },
        appendChild(child) { self.children.push(child); return child; },
        addEventListener(type, handler) { (self.listeners[type] = self.listeners[type] || []).push(handler); },
        focus() {},
        setAttribute(k, v) { self.attributes[k] = v; },
        getContext(kind) {
            if (kind !== '2d') return null;
            return {
                fillStyle: '#000',
                fillRect() {},
                getImageData() { return { data: [30, 33, 38, 255] }; }
            };
        }
    };
    self._text = '';
    return self;
}

// A tetrahedron and a truncated version of it, as the two sides of a diff.
const TET = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
];

function binarySTL(facets) {
    const buffer = new ArrayBuffer(84 + facets.length * 50);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    'stub exporter'.split('').forEach((c, i) => { bytes[i] = c.charCodeAt(0); });
    view.setUint32(80, facets.length, true);
    facets.forEach((facet, index) => {
        const off = 84 + index * 50;
        const values = facet.flat();
        [0, 0, 1].concat(values).forEach((value, k) => view.setFloat32(off + k * 4, value, true));
    });
    return buffer;
}

function blobOf(buffer) {
    return { blob: { arrayBuffer: () => Promise.resolve(buffer) }, byteLength: buffer.byteLength };
}

// The other form an .stl takes, so the frame can be driven with a text file too and not only the binary
// one. Same tetrahedron, same numbers, about three times the bytes.
function asciiSTL(facets) {
    const lines = ['solid stub exporter'];
    for (const facet of facets) {
        lines.push('  facet normal 0 0 1', '    outer loop');
        for (const point of facet) lines.push('    vertex ' + point.join(' '));
        lines.push('  endloop', 'endfacet');
    }
    lines.push('endsolid stub exporter');
    return new TextEncoder().encode(lines.join('\n')).buffer;
}

// Boot one frame: stub window + host, hand it the two sides, and report what it built. The host's own
// viewport and the display behind it are stubbed too, because how tall the frame asks to be depends on
// them; `screen` is deliberately an absurd number so a test can see which of the two was used.
async function boot({ working, base, config = {}, point = 'binaryPreview', hostVH = 1440, displayVH = 3000,
                      context = { filePath: 'parts/gear.stl', projectId: 'p', taskId: 't' } }) {
    const created = [];
    const hostCalls = { setSize: [], error: [], hide: 0, getBytes: [], loading: [], on: [] };

    const elements = { bar: node('div'), panes: node('div'), meta: node('div') };
    const document = {
        body: node('body'),
        getElementById: (id) => elements[id] || (elements[id] = node('div')),
        createElement: (tag) => node(tag)
    };

    const sandbox = {
        console, setTimeout, clearTimeout, TextDecoder, TextEncoder,
        document,
        devicePixelRatio: 1,
        innerHeight: 500,
        parent: hostVH ? { innerHeight: hostVH } : undefined,
        screen: displayVH ? { height: displayVH } : undefined,
        getComputedStyle: () => ({ backgroundColor: 'rgb(30, 33, 38)' }),
        addEventListener() {},
        requestAnimationFrame(fn) { (sandbox.frames = sandbox.frames || []).push(fn); return 1; },
        ResizeObserver: undefined,
        THREE: { __stub: true },
        STLRender: {
            available: () => true,
            create(canvas, THREE, opts) {
                const pane = {
                    opts, canvas, calls: [],
                    setMesh(parsed) { this.calls.push(['setMesh', parsed ? parsed.triangles : 0]); },
                    setGrid(spec) {
                        this.calls.push(['grid', spec ? spec.spacing : 0, spec ? spec.planes.join('+') : '']);
                    },
                    gridInfo: () => null,
                    setMode(m) { this.calls.push(['setMode', m]); },
                    setBackground(c) { this.calls.push(['background', c]); },
                    resize(w, h) { this.calls.push(['resize', w, h]); },
                    render() { this.calls.push(['render']); },
                    dispose() {}, isLost: () => false
                };
                created.push(pane);
                return pane;
            }
        }
    };

    sandbox.extHost = {
        config,
        context,
        point,
        granted: ['fs.getBytes', 'ui.setSize'],
        ready: () => Promise.resolve(),
        setSize: (h) => hostCalls.setSize.push(h),
        error: (m) => hostCalls.error.push(m),
        hide: () => { hostCalls.hide += 1; },
        loading: (m) => hostCalls.loading.push(m),
        log: () => {},
        on: (capability) => { hostCalls.on.push(capability); return () => {}; },
        fs: {
            getBytes: (side) => {
                hostCalls.getBytes.push(side);
                const value = side === 'working' ? working : base;
                if (!value) return Promise.reject(new Error('no such side: ' + side));
                return Promise.resolve(blobOf(value));
            }
        }
    };

    const context_ = vm.createContext(sandbox);
    const fakeRender = sandbox.STLRender;
    vm.runInContext(PARSE_SRC, context_, { filename: 'stl-parse.js' });
    // The grid's spacing maths belongs to the renderer, so this runs the real one for that and fakes only
    // what a GPU would be needed for.
    vm.runInContext(RENDER_SRC, context_, { filename: 'stl-render.js' });
    // Everything the renderer answers with is kept — gridSpacing, gridMainPlane, gridView, planeNames — and
    // only what needs a GPU is faked. Listing the pure functions by name here would silently hand the frame
    // test a missing function the moment the renderer grew one, and the frame would quietly do nothing.
    sandbox.STLRender = Object.assign({}, sandbox.STLRender,
                                      { available: fakeRender.available, create: fakeRender.create });
    vm.runInContext(PREVIEW_SRC, context_, { filename: 'stl-preview.js' });

    for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 10));

    // Read the live DOM each time: a rebuild after the comparison button is pressed must be seen.
    function look() {
        const captions = [];
        const canvases = [];
        (function walk(n) {
            if (n.tagName === 'div' && /cap/.test(n.className)) captions.push(n.textContent);
            if (n.tagName === 'canvas') canvases.push(n);
            n.children.forEach(walk);
        })(elements.panes);
        return {
            created, captions, canvases,
            pressed: elements.bar.children
                .filter((c) => c.tagName === 'button' && c.attributes['aria-pressed'] === 'true')
                .map((b) => b.textContent),
            gridCalls: created.map((p) => p.calls.filter((c) => c[0] === 'grid').map((c) => c[1])),
            // The draw-mode buttons carry aria-pressed too, so "which planes are on" has to be read off
            // the three plane buttons rather than off every pressed button in the bar.
            planePressed: elements.bar.children.filter((c) => c.tagName === 'button' &&
                ['Floor', 'Back', 'Side'].indexOf(c.textContent) >= 0 &&
                c.attributes['aria-pressed'] === 'true').map((b) => b.textContent),
            // Which planes are on is read off `aria-pressed`; what a square measures is on the tooltip.
            planeTitles: elements.bar.children.filter((c) => c.tagName === 'button' &&
                ['Floor', 'Back', 'Side'].indexOf(c.textContent) >= 0).map((b) => b.title || ''),
            gridPlanes: created.map((p) => p.calls.filter((c) => c[0] === 'grid').map((c) => c[2])),
            hostCalls,
            meta: elements.meta.textContent,
            buttons: elements.bar.children.filter((c) => c.tagName === 'button'),
            buttonLabels: elements.bar.children.filter((c) => c.tagName === 'button').map((b) => b.textContent),
            frames: sandbox.frames || []
        };
    }

    const first = look();
    first.look = look;
    first.press = function (label) {
        const button = look().buttons.find((b) => b.textContent === label);
        if (!button) throw new Error('no button labelled ' + label);
        (button.listeners.click || []).forEach((handler) => handler({ type: 'click' }));
    };
    // The orbit is driven through the same handlers the browser would fire, so "did the view move?" is
    // answered by the frame's own code rather than assumed. A real pointer event carries its id on every
    // move, and the frame keys its gestures on it — a move without one is a hover, not a drag.
    function pointerEvent(id, x, y, extra) {
        return Object.assign({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch',
                               preventDefault() {} }, extra || {});
    }
    function fire(type, event) {
        (elements.panes.listeners[type] || []).forEach((h) => h(event));
    }
    first.drag = function (dx, dy) {
        fire('pointerdown', pointerEvent(1, 100, 100, { pointerType: 'mouse' }));
        fire('pointermove', pointerEvent(1, 100 + dx, 100 + dy, { pointerType: 'mouse' }));
        fire('pointerup', pointerEvent(1, 100 + dx, 100 + dy, { pointerType: 'mouse' }));
    };
    first.touch = {
        down(id, x, y, extra) { fire('pointerdown', pointerEvent(id, x, y, extra)); },
        move(id, x, y) { fire('pointermove', pointerEvent(id, x, y)); },
        up(id) { fire('pointerup', pointerEvent(id, 0, 0)); }
    };
    first.wheel = function (deltaY) { fire('wheel', { deltaY: deltaY, preventDefault() {} }); };
    first.pose = function () {
        const v = created.length ? created[0].opts.view : null;   // one object, shared by every pane
        return v ? [Math.round(v.yaw * 100) / 100, Math.round(v.pitch * 100) / 100] : null;
    };
    // Where the part has been slid to, and how close it is fitted.
    first.place = function () {
        const v = created.length ? created[0].opts.view : null;
        return v ? [Math.round(v.panX * 1000) / 1000, Math.round(v.panY * 1000) / 1000,
                    Math.round(v.zoom * 1000) / 1000] : null;
    };
    // Drive the frame's own loop n frames, the way requestAnimationFrame would.
    first.tick = function (n) {
        for (let i = 0; i < (n || 1); i += 1) {
            const next = sandbox.frames[sandbox.frames.length - 1];
            if (next) next();
        }
    };
    // The host's window changing size is invisible to the frame; only the number moves.
    first.moveHostTo = function (h) { sandbox.parent.innerHeight = h; };
    return first;
}

// The stub nodes keep their handlers, so a test can press a button without a browser.
function press(button) {
    (button.listeners.click || []).forEach((handler) => handler({ type: 'click' }));
}

const TET_BYTES = binarySTL(TET);
const THREE_BYTES = binarySTL(TET.slice(0, 3));

// 1. A diff: both sides asked for, two panes, one shared camera, and a delta under them.
{
    const frame = await boot({ working: TET_BYTES, base: THREE_BYTES });
    check('diff: asked the host for both sides',
          frame.hostCalls.getBytes.join(',') === 'working,base', frame.hostCalls.getBytes.join(','));
    check('diff: built two panes', frame.created.length === 2, frame.created.length);
    check('diff: captioned before and after', frame.captions.join(',') === 'before,after', frame.captions.join(','));
    check('diff: drew the facets it parsed',
          frame.created[0].calls.some((c) => c[0] === 'setMesh' && c[1] === 3) &&
          frame.created[1].calls.some((c) => c[0] === 'setMesh' && c[1] === 4),
          JSON.stringify(frame.created.map((p) => p.calls.filter((c) => c[0] === 'setMesh'))));
    check('diff: one camera shared by both panes',
          frame.created.length === 2 && frame.created[0].opts.view === frame.created[1].opts.view);
    check('diff: leaves the file name to the dialog', !/gear\.stl/i.test(frame.meta), frame.meta);
    check('diff: counts each side', /before 3 facets/.test(frame.meta) && /after 4 facets/.test(frame.meta), frame.meta);
    check('diff: gives the delta', /\(\+1\)/.test(frame.meta), frame.meta);
    check('diff: says whether each shell closes',
          /closed shell \(was open shell\)/.test(frame.meta), frame.meta);
    check('diff: sized the frame', frame.hostCalls.setSize.length === 1 && frame.hostCalls.setSize[0] >= 320,
          JSON.stringify(frame.hostCalls.setSize));
    check('diff: offered the three draw modes',
          ['Shaded', 'Edges', 'Wireframe'].every((m) => frame.buttonLabels.includes(m)), frame.buttonLabels.join(','));
    check('diff: offered reset', frame.buttonLabels.includes('Reset view'), frame.buttonLabels.join(','));
    check('diff: painted from the resolved background',
          frame.created[0].opts.background === '#1e2126',
          JSON.stringify(frame.created[0].opts.background));
    check('diff: nothing was reported as an error', frame.hostCalls.error.length === 0, frame.hostCalls.error.join(';'));

    // The loop must draw and then ask for the next frame.
    if (frame.frames.length) frame.frames[0]();
    check('diff: the loop drew every pane',
          frame.created.every((p) => p.calls.some((c) => c[0] === 'render')));
}

// 1b. The room the frame asks for. The dialog is `max-height: 90vh` with a scrolling body and the element the
//     frame mounts into grows to whatever height it asks for — too little leaves the model a strip with empty
//     dialog underneath, too much makes the body scroll.
{
    const frame = await boot({ working: TET_BYTES });
    // 1440 * 0.9 - 118: 90% of the host's viewport, minus the dialog's own chrome. The numbers are
    //     pinned on purpose — a changed policy should fail a test rather than be quietly agreed with.
    check('height: fills the dialog the host has room for',
          frame.hostCalls.setSize.join(',') === '1178', JSON.stringify(frame.hostCalls.setSize));
    check('height: the host window, not the display behind it',
          frame.hostCalls.setSize[0] !== 1600, frame.hostCalls.setSize[0]);

    // A resized window moves the dialog's ceiling and says nothing to the frame, so the height is looked at
    // again every so often — and asking is silent unless the number actually moved.
    frame.moveHostTo(900);
    frame.tick(60);
    check('height: looks again once the window changed',
          frame.hostCalls.setSize.join(',') === '1178,692', JSON.stringify(frame.hostCalls.setSize));
    frame.tick(60);
    check('height: and says nothing when it did not',
          frame.hostCalls.setSize.length === 2, JSON.stringify(frame.hostCalls.setSize));
}

// A frame that cannot read the host's window still has to pick something, and pick it in stages: the
// display behind the browser is a better guess than a made-up number, and neither may exceed the ceiling.
{
    const blind = await boot({ working: TET_BYTES, hostVH: 0, displayVH: 0 });
    check('height: an unreadable viewport still gets a view',
          blind.hostCalls.setSize.join(',') === '602', JSON.stringify(blind.hostCalls.setSize));
    const screen = await boot({ working: TET_BYTES, hostVH: 0, displayVH: 3000 });
    check('height: the display beats the made-up number',
          screen.hostCalls.setSize.join(',') === '1600', JSON.stringify(screen.hostCalls.setSize));
    const short = await boot({ working: TET_BYTES, hostVH: 620 });
    check('height: a short window gets a short frame',
          short.hostCalls.setSize.join(',') === '440', JSON.stringify(short.hostCalls.setSize));
    const tiny = await boot({ working: TET_BYTES, hostVH: 380 });
    check('height: but never one too short to orbit in',
          tiny.hostCalls.setSize.join(',') === '320', JSON.stringify(tiny.hostCalls.setSize));
}

// In the explorer the frame is a card among other things, where a stage would be worse than a strip.
{
    const card = await boot({ working: TET_BYTES, point: 'fileBrowser' });
    check('height: in the explorer it stays a card',
          card.hostCalls.setSize.join(',') === '340', JSON.stringify(card.hostCalls.setSize));
}

// 1c. What the line under the view says. It speaks about the model — facets, size, whether it closes — and
//     not about the file: binary or ASCII STL is no one's business when deciding whether a part looks right,
//     and the byte count already says when an exporter wrote the bulky one.
{
    const frame = await boot({ working: TET_BYTES });
    check('line: the facets, the bytes, the size and whether it closes',
          /^4 facets · 284 B · 1 × 1 × 1 · closed shell/.test(frame.meta), frame.meta);
    check('line: the file encoding is not said', !/binary|ascii/i.test(frame.meta), frame.meta);

    const text = await boot({ working: asciiSTL(TET) });
    check('line: an ASCII file is drawn and called nothing but a model',
          /4 facets/.test(text.meta) && !/binary|ascii/i.test(text.meta), text.meta);
    check('line: and its shell is still judged', /closed shell/.test(text.meta), text.meta);

    // The one piece of bad news the line carries, said so it can be acted on rather than decoded.
    const open = await boot({ working: THREE_BYTES });
    check('line: an open shell is explained, not just named',
          /open shell — some edges belong to one facet/.test(open.meta), open.meta);

    // One facet past where the parser stops pairing edges: it checked nothing, so the line says nothing.
    // "shell unchecked" reads like a fault in the part when it is a sentence about our own budget.
    const many = [];
    for (let i = 0; i < 50001; i += 1) many.push(TET[i % 4]);
    const big = await boot({ working: binarySTL(many) });
    check('line: a shell that was not looked at is not commented on',
          /50,001 facets/.test(big.meta) && !/shell/i.test(big.meta), big.meta);
}

// 2. The same bytes on both sides is one pane, not two identical ones.
{
    const frame = await boot({ working: TET_BYTES, base: TET_BYTES });
    check('identical sides: one pane', frame.created.length === 1, frame.created.length);
    check('identical sides: one pane wears no chip', frame.captions.length === 0,
          JSON.stringify(frame.captions));
    check('identical sides: the offer is gone, there is nothing to compare',
          !frame.buttonLabels.includes('Compare with before'), frame.buttonLabels.join(','));
    check('identical sides: the one fact worth saying is said', /same bytes/.test(frame.meta), frame.meta);
    check('identical sides: no error', frame.hostCalls.error.length === 0, frame.hostCalls.error.join(';'));
}

// 3. Outside a diff the base side simply fails, and the frame carries on with the working side.
{
    const frame = await boot({ working: TET_BYTES, base: null });
    check('no diff: one pane from the working side', frame.created.length === 1, frame.created.length);
    check('no diff: the failed side is not an error',
          frame.hostCalls.error.length === 0, frame.hostCalls.error.join(';'));
    check('no diff: nothing on screen mentions an old side',
          !/old side|before|same bytes/i.test(frame.meta) && !frame.buttonLabels.includes('Compare with before'),
          frame.meta + ' | ' + frame.buttonLabels.join(','));
}

// 3b. Outside a task a diff cannot exist, so the old side is not asked for — that is the request the read
//     route answers 404 for. It is a button instead.
{
    const frame = await boot({ working: TET_BYTES, base: THREE_BYTES, context: { filePath: 'parts/gear.stl' } });
    check('no task: only the working side was asked for', frame.hostCalls.getBytes.join(',') === 'working',
          frame.hostCalls.getBytes.join(','));
    check('no task: one pane to start with', frame.created.length === 1, frame.created.length);
    check('no task: the comparison is offered', frame.buttonLabels.includes('Compare with before'),
          frame.buttonLabels.join(','));

    press(frame.buttons.find((b) => b.textContent === 'Compare with before'));
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 10));
    const after = frame.look();
    check('no task: pressing it fetched the old side', frame.hostCalls.getBytes.join(',') === 'working,base',
          frame.hostCalls.getBytes.join(','));
    check('no task: and the second pane appeared', after.created.length === 3 && after.captions.length === 2,
          'viewers=' + after.created.length + ' panes=' + after.captions.length);
    check('no task: labelled before and after', after.captions.join(',') === 'before,after', after.captions.join(','));
    check('no task: the delta is still stated', /before 3 facets/.test(after.meta) && /after 4 facets/.test(after.meta),
          after.meta);
}

// 3c. Where the old side is genuinely not there, the frame says nothing about it and offers nothing.
{
    const frame = await boot({ working: TET_BYTES, base: null, context: { filePath: 'parts/gear.stl' } });
    frame.press('Compare with before');
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 10));
    const after = frame.look();
    check('no old side: still one pane', after.canvases.length === 1, after.canvases.length);
    check('no old side: that one pane wears no chip', after.captions.length === 0,
          JSON.stringify(after.captions));
    check('no old side: the offer is gone',
          !after.buttonLabels.includes('Compare with before') && !after.buttonLabels.includes('No old side'),
          after.buttonLabels.join(','));
    check('no old side: the view says nothing about one',
          !/old side|before|same bytes/i.test(after.meta), after.meta);
    check('no old side: nothing was reported to the host as an error',
          frame.hostCalls.error.length === 0, frame.hostCalls.error.join(';'));
}

// 4. Nothing to read: the explorer can mount the frame before a file is chosen.
{
    const frame = await boot({ working: null, base: null, context: null });
    check('no file: the frame hid itself', frame.hostCalls.hide === 1 && frame.created.length === 0,
          'hide=' + frame.hostCalls.hide + ' panes=' + frame.created.length);
}

// 5. A file that is not an STL says so instead of showing an empty box.
{
    const frame = await boot({ working: new Uint8Array(4000).buffer, base: null });
    check('junk: reported once', frame.hostCalls.error.length === 1, frame.hostCalls.error.join(';'));
    check('junk: nothing drawn', frame.created.length === 0, frame.created.length);
    check('junk: the sentence is in the frame too', /flat/.test(frame.meta), JSON.stringify(frame.meta));
}

// 5b. A file the host will not hand over is refused with the reason, without repeating the name the
// dialog already shows in its header.
{
    const frame = await boot({ working: null, base: null, context: { filePath: 'parts/allparts-xtra.stl', taskId: 't' } });
    check('refused file: says why, and does not repeat the name',
          /no bytes/.test(frame.meta) && /no such side/.test(frame.meta) && !/allparts-xtra/.test(frame.meta),
          JSON.stringify(frame.meta));
    check('refused file: the old side was not chased with a second 404',
          frame.hostCalls.getBytes.join(',') === 'working', frame.hostCalls.getBytes.join(','));
}

// 6. The cap from Settings is handed to the parser.
{
    const frame = await boot({ working: TET_BYTES, base: null, config: { max_triangles: 2 } });
    check('cap: the setting reached the meta line', /capped at 2 of 4 facets/.test(frame.meta), frame.meta);
}

// 7. The reference grid: one plane by default, chosen as the face with the most area, each plane on its
//    own button, and what a square measures stated on those buttons rather than under the view — the line
//    under the view belongs to the model.
{
    // A slab the shape of the reported part: 30 × 85 × 29.6, where the wall behind it (30 × 85) is the
    // largest face, the wall to the side (85 × 29.6) nearly as large, and the floor (30 × 29.6) smallest.
    const SLAB = binarySTL(TET.map((f) => f.map((p) => [p[0] * 30, p[1] * 85, p[2] * 29.6])));
    const slab = await boot({ working: SLAB, base: null });
    check('grid: by default exactly one plane is drawn, and it is the face with the most area',
          slab.gridPlanes[0].length === 1 && slab.gridPlanes[0][0] === 'back',
          JSON.stringify(slab.gridPlanes));
    check('grid: all three buttons are there and only the chosen one is switched on',
          ['Floor', 'Back', 'Side'].every((b) => slab.buttonLabels.includes(b)) &&
          slab.planePressed.join(',') === 'Back',
          slab.buttonLabels.join(',') + ' | ' + slab.planePressed.join(','));
    check('grid: the button says what its square measures and what unit it assumes',
          slab.planeTitles.length === 3 &&
          slab.planeTitles.every((t) => /1 square = 1 cm \(1 unit = 1 mm\)/.test(t)) &&
          !/grid|square|unit/i.test(slab.meta),
          slab.planeTitles.join(' | ') + ' || ' + slab.meta);

    // The view is chosen with the plane, not fixed for every part: a wall meant to be read as a ruler is
    // met near head-on, where the old three-quarter angle sheared its squares into a hatch.
    check('grid: the first look is turned to meet the chosen wall',
          slab.pose()[0] === 0.2 && slab.pose()[1] === 0.14, JSON.stringify(slab.pose()));
    slab.drag(180, 120);
    check('grid: dragging orbits the model',
          slab.pose()[0] !== 0.2 || slab.pose()[1] !== 0.14, JSON.stringify(slab.pose()));
    slab.press('Reset view');
    check('grid: Reset view goes back to the angle that wall is read from, not one fixed angle',
          slab.pose()[0] === 0.2 && slab.pose()[1] === 0.14, JSON.stringify(slab.pose()));

    slab.press('Floor');
    const two = slab.look();
    check('grid: pressing a second button adds a plane, listed the renderer\'s way round',
          two.gridPlanes[0][two.gridPlanes[0].length - 1] === 'floor+back' &&
          two.planePressed.join(',') === 'Floor,Back',
          JSON.stringify(two.gridPlanes) + ' | ' + two.planePressed.join(','));

    slab.press('Back');
    const one = slab.look();
    check('grid: pressing the chosen one off leaves the other',
          one.gridPlanes[0][one.gridPlanes[0].length - 1] === 'floor' &&
          one.planePressed.join(',') === 'Floor',
          JSON.stringify(one.gridPlanes) + ' | ' + one.planePressed.join(','));

    slab.press('Floor');
    const none = slab.look();
    check('grid: with every plane off nothing is asked for and nothing is claimed',
          none.gridPlanes[0][none.gridPlanes[0].length - 1] === '' && !/grid/i.test(none.meta) &&
          none.planeTitles.every((t) => !/square/.test(t)) &&
          none.planePressed.length === 0,
          JSON.stringify(none.gridPlanes) + ' | ' + none.planeTitles.join(' | ') + ' | ' + none.meta);

    // Choosing a plane later is an answer about the drawing, not an order about the orbit: by now the
    // person may have turned the part to look at something, and having it spin away would be unforgivable.
    const held = slab.pose();
    slab.press('Side');
    const chosen = slab.look().gridPlanes[0];
    check('grid: choosing a plane afterwards leaves the orbit where the person left it',
          JSON.stringify(slab.pose()) === JSON.stringify(held) && chosen[chosen.length - 1] === 'side',
          JSON.stringify(slab.pose()) + ' | ' + JSON.stringify(chosen));
    slab.press('Reset view');
    check('grid: and Reset then brings the pose that plane is meant to be read from',
          slab.pose()[0] === -1.37 && slab.pose()[1] === 0.14, JSON.stringify(slab.pose()));

    // The stub's tetrahedron is a cube-corner 1 × 1 × 1, so all three faces tie and the floor wins — the
    // part reads better standing on something than leaning. Its centimetre square would be two lines, so
    // the finer square is chosen and the reason said rather than the change hidden.
    const tet = await boot({ working: TET_BYTES, base: THREE_BYTES });
    check('grid: a tie goes to the floor',
          tet.gridPlanes[0][0] === 'floor' && tet.planePressed.join(',') === 'Floor',
          JSON.stringify(tet.gridPlanes) + ' | ' + tet.planePressed.join(','));
    check('grid: with the floor chosen the first look is the three-quarter view, so the part has sides',
          tet.pose()[0] === 0.62 && tet.pose()[1] === 0.42, JSON.stringify(tet.pose()));
    check('grid: both panes of a diff share one plane and one square size',
          tet.gridPlanes.every((calls) => calls.join('|') === 'floor') &&
          tet.gridCalls[0][0] === tet.gridCalls[1][0],
          JSON.stringify(tet.gridPlanes) + ' | ' + JSON.stringify(tet.gridCalls));
    check('grid: a square finer than the one asked for is explained where the square is stated',
          tet.planeTitles.every((t) =>
              /1 square = 1 mm \(1 unit = 1 mm\): the model is 0\.1 cm across/.test(t)),
          tet.planeTitles.join(' | '));
}

{
    // 100 m across, read as millimetres: a centimetre square would need ten thousand lines to one edge.
    const HUGE = binarySTL(TET.map((f) => f.map((p) => p.map((v) => v * 100000))));
    const big = await boot({ working: HUGE, base: null });
    check('grid: a huge part gets a square it can be read against, and the reason why',
          /1 square = 1 m \(1 unit = 1 mm\): 1 cm would need 10,001 lines/.test(big.planeTitles.join(' ')),
          big.planeTitles.join(' | '));
}

// 11. The gestures: one finger turns the part as it always did, two pinch to zoom, two moving together slide
//     it, shift+drag moves it with a mouse that has no second finger, and the wheel keeps zooming (CAD habit).
//     The stub's canvas is 300 × 200, which is what turns dragged pixels into the fraction of a half-height the
//     renderer is handed.
{
    const f = await boot({ working: TET_BYTES, base: null });
    const before = f.pose();

    f.touch.down(1, 100, 100);
    f.touch.move(1, 160, 130);
    f.touch.up(1);
    check('gesture: one finger still orbits the part, and does not slide it',
          f.pose()[0] !== before[0] && f.place()[0] === 0 && f.place()[1] === 0 && f.place()[2] === 1,
          JSON.stringify([before, f.pose(), f.place()]));

    // Spread symmetrically about the middle, so zoom is all that can change: a pinch whose middle moves is
    // also a slide, and the frame is meant to read both.
    f.touch.down(1, 100, 100);
    f.touch.down(2, 200, 100);                       // 100 apart, middle (150, 100)
    f.touch.move(1, 50, 100);
    f.touch.move(2, 250, 100);                       // 200 apart, same middle
    check('gesture: spreading two fingers zooms in and slides nothing',
          Math.abs(f.place()[2] - 2) < 1e-6 && f.place()[0] === 0 && f.place()[1] === 0,
          JSON.stringify(f.place()));
    f.touch.move(1, 100, 100);
    f.touch.move(2, 200, 100);
    check('gesture: and bringing them together zooms out again',
          Math.abs(f.place()[2] - 1) < 1e-6, JSON.stringify(f.place()));

    // A second finger freezes the orbit — it neither turns the part nor jumps it.
    const frozen = f.pose();
    f.touch.down(3, 50, 50);
    check('gesture: a second finger neither turns the part nor jumps it',
          JSON.stringify(f.pose()) === JSON.stringify(frozen), JSON.stringify([frozen, f.pose()]));
    f.touch.up(3);
    f.touch.up(1);
    f.touch.up(2);

    // Two fingers travelling together slide the part and leave the angle alone.
    const zoomed = f.place()[2];
    f.touch.down(4, 100, 100);
    f.touch.down(5, 200, 100);
    f.touch.move(4, 130, 120);                       // both move 30 across, 20 down
    f.touch.move(5, 230, 120);
    check('gesture: two fingers travelling together slide the part',
          Math.abs(f.place()[0] + 0.3) < 1e-6 && Math.abs(f.place()[1] - 0.2) < 1e-6 &&
          f.place()[2] === zoomed,
          JSON.stringify(f.place()));
    check('gesture: and the angle is left where it was while they do',
          JSON.stringify(f.pose()) === JSON.stringify(frozen), JSON.stringify([frozen, f.pose()]));
    f.touch.up(4);
    f.touch.up(5);

    const zoomBefore = f.place()[2];
    f.wheel(-120);
    check('gesture: the wheel still zooms, as it always did',
          f.place()[2] > zoomBefore, JSON.stringify([zoomBefore, f.place()]));

    // Without a second finger, a mouse user has no way to slide the part at all but this one.
    const angle = f.pose();
    f.touch.down(6, 100, 100, { pointerType: 'mouse', shiftKey: true });
    f.touch.move(6, 150, 100);
    f.touch.up(6);
    check('gesture: shift+drag slides with a mouse instead of turning it',
          f.place()[0] < -0.3 && JSON.stringify(f.pose()) === JSON.stringify(angle),
          JSON.stringify([f.place(), f.pose()]));

    f.press('Reset view');
    check('gesture: Reset view puts the angle, the zoom and the slide all back',
          f.place()[0] === 0 && f.place()[1] === 0 && f.place()[2] === 1,
          JSON.stringify(f.place()));
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
