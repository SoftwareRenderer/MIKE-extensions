// The frame in a real browser: Chromium loads the actual index.html, the actual vendored three.js, the actual
// parser and renderer, over a local server that mirrors MIKE's serving rules — a CSP whose script-src has no
// 'unsafe-inline', and /host-client.js delivered before the extension's own script. It is a browser and not
// MIKE: the host client here is a stand-in, so only the frame's side of the contract is under test, and the
// host's half — mounting the frame, answering getBytes — is Try Extension's (tests/README.md).

// Needs node and playwright with a chromium:
//   npm i playwright && npx playwright install --with-deps chromium
//   node tests/browser-stl.mjs        exits non-zero on the first failure
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

let failed = 0;
function check(name, condition, detail) {
    if (condition) console.log('ok   ' + name);
    else { failed += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' (' + detail + ')')); }
}

// ------------------------------------------------------------------ STL fixtures

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
    'browser fixture'.split('').forEach((c, i) => { bytes[i] = c.charCodeAt(0); });
    view.setUint32(80, facets.length, true);
    facets.forEach((facet, index) => {
        const off = 84 + index * 50;
        [0, 0, 1].concat(facet.flat()).forEach((value, k) => view.setFloat32(off + k * 4, value, true));
    });
    return new Uint8Array(buffer);
}

function asciiSTL(facets) {
    const lines = ['solid browser fixture'];
    for (const facet of facets) {
        lines.push('  facet normal 0 0 1', '    outer loop');
        for (const v of facet) lines.push('      vertex ' + v.join(' '));
        lines.push('    endloop', '  endfacet');
    }
    lines.push('endsolid browser fixture');
    return new TextEncoder().encode(lines.join('\n'));
}

function sphereFacets(rings, segments, radius) {
    const point = (ring, segment) => {
        const phi = Math.PI * ring / rings, theta = 2 * Math.PI * segment / segments;
        return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta),
                radius * Math.cos(phi)];
    };
    const facets = [];
    for (let r = 0; r < rings; r += 1) {
        for (let s = 0; s < segments; s += 1) {
            const a = point(r, s), b = point(r + 1, s);
            const c = point(r + 1, (s + 1) % segments), d = point(r, (s + 1) % segments);
            if (r < rings - 1) facets.push([a, b, c]);
            if (r > 0) facets.push([a, c, d]);
        }
    }
    return facets;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const SPHERE_FACETS = sphereFacets(30, 44, 12);                // 2,552 facets, closed
const SMALL_FACETS = sphereFacets(18, 26, 9);                   //   884 facets, closed
const SPHERE = binarySTL(SPHERE_FACETS);
const SMALL_SPHERE = binarySTL(SMALL_FACETS);
const TET_BIN = binarySTL(TET);
const TET_TXT = asciiSTL(TET);
const HEAVY_FACETS = sphereFacets(300, 400, 40);               // 239,200 facets
const HEAVY = binarySTL(HEAVY_FACETS);

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');  // as the frame groups them
const SPHERE_COUNT = SPHERE_FACETS.length;
const SMALL_COUNT = SMALL_FACETS.length;

// ------------------------------------------------------------------ the stand-in host

// Written from references/manifest.md's list of what host-client.js puts on window. It records what the
// frame asked for so the test can assert on it.
const HOST_CLIENT = `(function () {
    var scenario = window.__mikeStub || {};
    var calls = { setSize: [], error: [], hide: 0, getBytes: [], on: [], loading: [], log: [] };
    window.__hostCalls = calls;

    function bytesOf(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
    }

    var fs = scenario.sides ? {
        getBytes: function (side) {
            calls.getBytes.push(side);
            var value = scenario.sides[side];
            if (!value) return Promise.reject(new Error('no such side: ' + side));
            var bytes = bytesOf(value);
            return Promise.resolve({ blob: new Blob([bytes], { type: 'model/stl' }), byteLength: bytes.length });
        }
    } : undefined;

    window.extHost = {
        config: scenario.config || {},
        context: 'context' in scenario ? scenario.context : { filePath: 'parts/gear.stl', projectId: 'p', taskId: 't' },
        granted: scenario.granted || ['fs.getBytes', 'ui.setSize'],
        ready: function () { return Promise.resolve(); },
        setSize: function (h) { calls.setSize.push(h); },
        error: function (m) { calls.error.push(String(m)); },
        hide: function () { calls.hide += 1; },
        loading: function (m) { calls.loading.push(String(m)); },
        log: function (l, m) { calls.log.push(l + ': ' + m); },
        on: function (capability) { calls.on.push(capability); return function () {}; },
        fs: fs
    };
}());`;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json'
};

function serve() {
    const server = http.createServer((req, res) => {
        const route = req.url.split('?')[0];
        if (route === '/host-client.js') {
            res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
            res.end(HOST_CLIENT);
            return;
        }
        const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end('not found: ' + route);
            return;
        }
        res.writeHead(200, {
            'content-type': MIME[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'no-store',
            // The shape MIKE's /extensions/ policy is described as: no inline script, no remote script.
            'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'none'; object-src 'none'"
        });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/index.html` }));
    });
}

// ------------------------------------------------------------------ driving one scenario

async function open(browser, base, scenario) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
    const problems = [];
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push('console: ' + msg.text());
    });
    page.on('requestfailed', (req) => problems.push('request failed: ' + req.url()));

    await page.addInitScript((s) => {
        window.__mikeStub = s;
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.blockedURI || e.originalText));
    }, scenario);
    await page.goto(base, { waitUntil: 'load' });
    return { page, problems };
}

const settle = async (page, ms = 900) => {
    await page.waitForTimeout(ms);
    return page.evaluate(() => ({
        meta: document.getElementById('meta').textContent,
        bodyText: document.body.textContent,
        bar: Array.prototype.map.call(document.querySelectorAll('#bar button'), (b) => b.textContent),
        pressed: Array.prototype.map.call(document.querySelectorAll('#bar button[aria-pressed="true"]'),
                                         (b) => b.textContent),
        // What a grid square measures is on the plane buttons, not under the view.
        planeTitles: Array.prototype.map.call(
            document.querySelectorAll('#bar button'),
            (b) => (/^(Floor|Back|Side)$/.test(b.textContent) ? b.title : null)).filter((t) => t !== null),
        captions: Array.prototype.map.call(document.querySelectorAll('.cap'), (c) => c.textContent),
        canvases: document.querySelectorAll('#panes canvas').length,
        notice: (document.querySelector('.notice') || {}).textContent || '',
        THREE: typeof window.THREE,
        STLParse: typeof window.STLParse,
        STLRender: typeof window.STLRender,
        csp: window.__csp,
        calls: window.__hostCalls
    }));
};

// Chromium decodes its own screenshots: the canvas pixels come back through a 2D canvas, so the test
// never needs a PNG decoder of its own. Calling it twice with the same key also reports how much of the
// picture moved between the two calls, which is how "did the model actually turn" is answered.
async function pixels(page, selector, key) {
    const handle = await page.$(selector);
    if (!handle) return null;
    const png = await handle.screenshot();
    return page.evaluate(async ({ b64, key }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;

        window.__pix = window.__pix || {};
        const before = window.__pix[key];
        let changed = null;
        if (before && before.length === d.length) {
            let moved = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (Math.abs(d[i] - before[i]) > 8 || Math.abs(d[i + 1] - before[i + 1]) > 8 ||
                    Math.abs(d[i + 2] - before[i + 2]) > 8) moved += 1;
            }
            changed = moved / (d.length / 4);
        }
        window.__pix[key] = d.slice();

        const colours = new Set();
        let lit = 0;
        // Where the lit pixels are, as well as how many: "the model fills the pane" and "the model was cut
        // off at the edge of the pane" are both questions about the bounding box, not the count.
        let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, edge = false;
        for (let i = 0; i < d.length; i += 4) {
            colours.add((d[i] >> 2) + ',' + (d[i + 1] >> 2) + ',' + (d[i + 2] >> 2));
            if (d[i] + d[i + 1] + d[i + 2] > 200) {
                lit += 1;
                const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
                if (px === 0 || py === 0 || px === c.width - 1 || py === c.height - 1) edge = true;
            }
        }
        return { width: c.width, height: c.height, colours: colours.size, lit,
                 pixels: d.length / 4, changed: changed, box: [minX, minY, maxX, maxY], edge: edge };
    }, { b64: png.toString('base64'), key: key || selector });
}

function drewSomething(picture, name) {
    check(name + ': pixels were painted', !!picture && picture.width > 20 && picture.height > 20,
          picture && picture.width + 'x' + picture.height);
    // A flat fill would be one colour; a lit model is hundreds of them, with a good few above the
    // background's darkness.
    check(name + ': more than a flat fill', !!picture && picture.colours > 12, picture && picture.colours);
    check(name + ': something lit by the lights', !!picture && picture.lit / picture.pixels > 0.02,
          picture && (picture.lit / picture.pixels).toFixed(3));
}

function turned(picture, name) {
    if (!picture) { check(name, false, 'no picture'); return; }
    check(name, picture.changed !== null && picture.changed > 0.01,
          'moved ' + (picture.changed === null ? 'n/a' : (picture.changed * 100).toFixed(1) + '%') +
          ' of the pane');
}

// ------------------------------------------------------------------ the run

const { server, base } = await serve();
const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});

try {
    // 1. A binary STL in the editor's preview: one pane, the truth about the file, and pixels.
    {
        const { page, problems } = await open(browser, base, { sides: { working: b64(SPHERE) } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        const seen = await settle(page, 1200);

        check('binary: three.js, the parser and the renderer all loaded under that CSP',
              seen.THREE === 'object' && seen.STLParse === 'object' && seen.STLRender === 'object',
              [seen.THREE, seen.STLParse, seen.STLRender].join('/'));
        check('binary: no CSP violation was raised', seen.csp.length === 0, JSON.stringify(seen.csp));
        check('binary: the working side was read, and the diff\'s old side tried and failed',
              seen.calls.getBytes.join(',') === 'working,base', seen.calls.getBytes.join(','));
        check('binary: one pane', seen.canvases === 1, seen.canvases);
        check('binary: the meta line tells the truth about the file',
              new RegExp(grouped(SPHERE_COUNT) + ' facets').test(seen.meta) &&
              /closed shell/.test(seen.meta) &&
              /24 × 24 × 24/.test(seen.meta), seen.meta);
        check('binary: and says nothing about how the bytes are stored',
              !/binary|ascii/i.test(seen.meta), seen.meta);
        // The dialog's own header already titles the preview with the file; the frame adds no copy.
        check('binary: the frame never repeats the file name', !/gear\.stl/i.test(seen.bodyText), seen.bodyText.slice(0, 200));
        check('binary: the frame asked for a height', seen.calls.setSize.length === 1 && seen.calls.setSize[0] >= 320,
              JSON.stringify(seen.calls.setSize));
        check('binary: nothing went wrong in the page', problems.length === 0, problems.join(' | '));
        drewSomething(await pixels(page, '#panes .pane canvas'), 'binary');
        await page.close();
    }

    // 2. The same shape as text.
    {
        const { page, problems } = await open(browser, base, { sides: { working: b64(TET_TXT) } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        const seen = await settle(page, 900);
        check('ascii: read as ASCII', /4 facets/.test(seen.meta) && /ascii/.test(seen.meta), seen.meta);
        check('ascii: nothing went wrong', problems.length === 0, problems.join(' | '));
        drewSomething(await pixels(page, '#panes .pane canvas'), 'ascii');
        await page.close();
    }

    // 3. A diff: two panes, one camera, and a drag on one turning the other.
    {
        const { page, problems } = await open(browser, base, {
            sides: { working: b64(SPHERE), base: b64(SMALL_SPHERE) }
        });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        await page.waitForSelector('#panes .pane:nth-child(2) canvas', { timeout: 20000 });
        const seen = await settle(page, 1400);

        check('diff: both sides were requested', seen.calls.getBytes.join(',') === 'working,base',
              seen.calls.getBytes.join(','));
        check('diff: two panes', seen.canvases === 2, seen.canvases);
        check('diff: captioned before and after', seen.captions.join(',') === 'before,after', seen.captions.join(','));
        check('diff: the delta is stated',
              new RegExp('before ' + grouped(SMALL_COUNT) + ' facets').test(seen.meta) &&
              new RegExp('after ' + grouped(SPHERE_COUNT) + ' facets').test(seen.meta) &&
              seen.meta.indexOf('(+' + grouped(SPHERE_COUNT - SMALL_COUNT) + ')') > 0 &&
              /closed shell/.test(seen.meta), seen.meta);

        const left = await pixels(page, '#panes .pane:nth-child(1) canvas', 'left');
        const right = await pixels(page, '#panes .pane:nth-child(2) canvas', 'right');
        drewSomething(left, 'diff/before');
        drewSomething(right, 'diff/after');

        const box = await (await page.$('#panes .pane:nth-child(1) canvas')).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 60, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(500);

        turned(await pixels(page, '#panes .pane:nth-child(1) canvas', 'left'),
               'diff: dragging turned the pane it was dragged on');
        turned(await pixels(page, '#panes .pane:nth-child(2) canvas', 'right'),
               'diff: dragging turned the other pane too (one shared camera)');
        check('diff: nothing went wrong', problems.length === 0, problems.join(' | '));
        await page.close();
    }

    // 4. The draw modes really are different pictures, not one picture with a pressed button.
    {
        const { page } = await open(browser, base, { sides: { working: b64(SPHERE) } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        await settle(page, 1000);
        const shaded = await pixels(page, '#panes .pane canvas', 'modes');
        drewSomething(shaded, 'modes/shaded');
        await page.click('#bar button:has-text("Wireframe")');
        await page.waitForTimeout(500);
        turned(await pixels(page, '#panes .pane canvas', 'modes'), 'modes: wireframe is a different picture from shaded');
        await page.click('#bar button:has-text("Edges")');
        await page.waitForTimeout(500);
        turned(await pixels(page, '#panes .pane canvas', 'modes'), 'modes: edges is a different picture from wireframe');
        const pressed = await page.$$eval('#bar button[aria-pressed="true"]', (n) => n.map((b) => b.textContent));
        check('modes: the pressed button is the one clicked', pressed.join(',') === 'Edges', pressed.join(','));
        await page.close();
    }

    // 5. The same bytes on both sides is one pane.
    {
        const { page } = await open(browser, base, { sides: { working: b64(TET_BIN), base: b64(TET_BIN) } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        const seen = await settle(page, 900);
        check('identical sides: one pane', seen.canvases === 1, seen.canvases);
        check('identical sides: one pane wears no chip', seen.captions.length === 0, JSON.stringify(seen.captions));
        await page.close();
    }

    // 6. Junk is refused in the frame, once, without a thrown error.
    {
        const junk = new Uint8Array(4000);
        const { page, problems } = await open(browser, base, { sides: { working: b64(junk) } });
        const seen = await settle(page, 1200);
        check('junk: no pane', seen.canvases === 0, seen.canvases);
        check('junk: the frame says why', seen.notice.length > 0 && /facet/.test(seen.notice), JSON.stringify(seen.notice));
        check('junk: reported to the host once', seen.calls.error.length === 1, JSON.stringify(seen.calls.error));
        check('junk: nothing threw', problems.length === 0, problems.join(' | '));
        await page.close();
    }

    // 7. A frame mounted with no file at all — the explorer before a file is picked — hides instead of
    //    shouting.
    {
        const { page } = await open(browser, base, { context: null });
        const seen = await settle(page, 800);
        check('no file: the frame hid itself', seen.calls.hide === 1 && seen.canvases === 0,
              'hide=' + seen.calls.hide + ' canvases=' + seen.canvases);
        await page.close();
    }

    // 8. The cap from Settings is honoured in the browser, not only in Node.
    {
        const { page } = await open(browser, base, { sides: { working: b64(SPHERE) }, config: { max_triangles: 100 } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        const seen = await settle(page, 900);
        check('cap: the setting reached the view',
              new RegExp('capped at 100 of ' + grouped(SPHERE_COUNT) + ' facets').test(seen.meta) &&
              new RegExp('^' + grouped(100) + ' facets').test(seen.meta),
              seen.meta);
        await page.close();
    }

    // 9. The file the person reported against, kept under tests/fixtures so the press never serves it.
    {
        const real = fs.readFileSync(path.join(here, 'fixtures', 'allparts-xtra.stl'));
        const { page, problems } = await open(browser, base, {
            sides: { working: b64(real), base: b64(SMALL_SPHERE) },
            context: { filePath: 'parts/allparts-xtra.stl' }          // an editor mount: no task
        });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        const seen = await settle(page, 1400);
        check('real file: one read, and no second request for a side that is not there',
              seen.calls.getBytes.join(',') === 'working', seen.calls.getBytes.join(','));
        check('real file: 7,046 facets, 344 KB, the size it measures, and a closed shell',
              /7,046 facets/.test(seen.meta) && /344 KB/.test(seen.meta) &&
              /30 × 85 × 29\.644/.test(seen.meta) && /closed shell/.test(seen.meta) &&
              !/binary|ascii/i.test(seen.meta),
              seen.meta);
        check('real file: the frame never repeats the file name', !/allparts-xtra/i.test(seen.bodyText),
              seen.bodyText.slice(0, 200));
        check('real file: the comparison is offered',
              seen.bar.includes('Compare with before'), seen.bar.join(','));
        check('real file: nothing went wrong', problems.length === 0, problems.join(' | '));
        check('real file: the square and the unit it assumes are on the plane buttons, not under the view',
              seen.planeTitles.length === 3 &&
              seen.planeTitles.every((t) => /1 square = 1 cm \(1 unit = 1 mm\)/.test(t)) &&
              !/grid|square|\bunit\b/i.test(seen.meta),
              seen.planeTitles.join(' | ') + ' || ' + seen.meta);
        check('real file: one button per plane, and only the widest face switched on',
              ['Floor', 'Back', 'Side'].every((b) => seen.bar.includes(b)) &&
              seen.pressed.join(',') === 'Back',
              seen.bar.join(',') + ' | ' + seen.pressed.join(','));
        // The view it opens in should already be the one the chosen plane is read from — pressing Reset
        // before doing anything else should change nothing on the canvas.
        await pixels(page, '#panes .pane canvas', 'pose');
        await page.click('#bar button:text-is("Reset view")');
        await page.waitForTimeout(450);
        const resetPose = await pixels(page, '#panes .pane canvas', 'pose');
        check('real file: the view it opens in is the pose Reset view goes to',
              !!resetPose && resetPose.changed !== null && resetPose.changed < 0.005,
              resetPose && (resetPose.changed === null ? 'no first picture'
                                                       : (resetPose.changed * 100).toFixed(2) + '% moved'));
        // The frame's own test proves the call was made; this proves three.js painted something that
        // disappears when that plane is switched off. Thin lines behind a solid model move a small share
        // of the pane, so the bar is lower than the one a turn of the model has to clear.
        await pixels(page, '#panes .pane canvas', 'grid');
        await page.click('#bar button:text-is("Back")');
        await page.waitForTimeout(500);
        const noGrid = await pixels(page, '#panes .pane canvas', 'grid');
        check('real file: switching that plane off changes the picture',
              !!noGrid && noGrid.changed !== null && noGrid.changed > 0.002,
              noGrid && (noGrid.changed === null ? 'no before picture'
                                                 : (noGrid.changed * 100).toFixed(2) + '% of the pane'));
        await page.click('#bar button:text-is("Floor")');
        await page.waitForTimeout(400);
        const withFloor = await settle(page, 300);
        check('real file: switching another on lights its button and claims nothing under the view',
              withFloor.pressed.join(',') === 'Floor' && !/grid/i.test(withFloor.meta),
              withFloor.meta + ' | ' + withFloor.pressed.join(','));
        await page.click('#bar button:text-is("Floor")');
        await page.waitForTimeout(400);
        // A different plane is read from a different pose: with only the side wall lit, Reset turns the
        // part to meet it, which is a plainly different picture from the wall it opened on.
        await page.click('#bar button:text-is("Side")');
        await page.click('#bar button:text-is("Reset view")');
        await page.waitForTimeout(500);
        const sidePose = await pixels(page, '#panes .pane canvas', 'pose');
        check('real file: another plane is read from its own, visibly different pose',
              !!sidePose && sidePose.changed !== null && sidePose.changed > 0.05,
              sidePose && (sidePose.changed === null ? 'no picture to compare'
                                                     : (sidePose.changed * 100).toFixed(2) + '% moved'));
        await page.click('#bar button:text-is("Side")');
        await page.click('#bar button:text-is("Back")');
        await page.click('#bar button:text-is("Reset view")');
        await page.waitForTimeout(400);
        drewSomething(await pixels(page, '#panes .pane canvas', 'real'), 'real file');

        await page.click('#bar button:has-text("Compare with before")');
        await page.waitForSelector('#panes .pane:nth-child(2) canvas', { timeout: 20000 });
        const after = await settle(page, 1200);
        check('real file: comparing brings in the other side', after.canvases === 2, after.canvases);
        check('real file: the delta is stated', /before 884 facets/.test(after.meta) &&
              /after 7,046 facets/.test(after.meta), after.meta);
        await page.close();
    }

    // 9b. The room: MIKE's dialog is capped at 90% of its own viewport and its body scrolls, and the frame fills
    //     whatever height the host gives it — so the height asked for must track the window, and the part must use
    //     the room it is given rather than sit in a strip. The grid is put away with its own buttons first, so the
    //     fit is the only thing in the picture; and since this harness is the top page rather than an iframe, what
    //     is proved here is the asking and the filling while MIKE applying the height is Try Extension's half.
    {
        const { page, problems } = await open(browser, base, {
            sides: { working: b64(SPHERE) }
        });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        await settle(page, 1200);
        const gridOff = await page.evaluate(() => {
            const names = ['Floor', 'Back', 'Side'];
            const pressed = () => [...document.querySelectorAll('#bar button')].filter((b) =>
                names.includes(b.textContent.trim()) && b.getAttribute('aria-pressed') === 'true');
            const clicked = [];
            for (let guard = 0; guard < 4; guard += 1) {
                const on = pressed();
                if (!on.length) break;
                clicked.push(on[0].textContent.trim());
                on[0].click();            // the bar is rebuilt on every click, so each press re-queries
            }
            return { clicked: clicked, left: pressed().map((b) => b.textContent.trim()) };
        });
        await settle(page, 600);
        check('room: the grid goes away through its own buttons, leaving the fit alone to measure',
              gridOff.clicked.length === 1 && gridOff.left.length === 0, JSON.stringify(gridOff));
        const asked = await page.evaluate(() => window.__hostCalls.setSize.slice());
        check('room: asks for the dialog the host has, not a strip of its own choosing',
              asked.join(',') === '566', JSON.stringify(asked));      // 760 * 0.9 - 118
        check('room: that is more than the fixed ceiling this used to hold',
              asked[0] > 560, JSON.stringify(asked));
        const short = await pixels(page, '#panes .pane canvas', 'room-short');
        check('room: the pane takes the height it is given',
              !!short && short.height > 760 * 0.6, short && short.width + 'x' + short.height);
        const span = short ? Math.max(short.box[2] - short.box[0], short.box[3] - short.box[1]) : 0;
        check('room: the part fills the tighter axis of the pane',
              !!short && span > 0.6 * Math.min(short.width, short.height),
              short && JSON.stringify(short.box) + ' in ' + short.width + 'x' + short.height);
        check('room: and nothing is cut off at its edge', !!short && short.edge === false,
              short && JSON.stringify(short.box));

        await page.setViewportSize({ width: 1180, height: 1300 });
        await page.waitForTimeout(900);
        const taller = await page.evaluate(() => window.__hostCalls.setSize.slice());
        check('room: a taller window is asked about again, and asked bigger',
              taller.length >= 2 && taller[taller.length - 1] > asked[0], JSON.stringify(taller));
        const tall = await pixels(page, '#panes .pane canvas', 'room-tall');
        check('room: the pane grew with it', !!short && !!tall && tall.height > short.height * 1.3,
              short && tall && short.height + ' -> ' + tall.height);
        check('room: nothing went wrong', problems.length === 0, problems.join(' | '));
        await page.close();
    }

    // 9c. The gestures, under a real browser: the CSS that hands them to the frame rather than to the
    //     dialog's own scrollbar, and the two a mouse can perform. A pinch is a second finger, which this
    //     harness cannot put on the glass — tests/frame-stl.mjs drives that one through the same handlers.
    {
        const { page, problems } = await open(browser, base, { sides: { working: b64(SPHERE) } });
        await page.waitForSelector('#panes canvas', { timeout: 20000 });
        await settle(page, 1000);
        const css = await page.evaluate(() => {
            const s = getComputedStyle(document.getElementById('panes'));
            return { touch: s.touchAction, select: s.userSelect || s.webkitUserSelect };
        });
        check('gestures: the pane keeps the browser out of them',
              css.touch === 'none' && /none/.test(css.select || ''), JSON.stringify(css));

        const box = await (await page.$('#panes .pane canvas')).boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await pixels(page, '#panes .pane canvas', 'wheel');
        await page.mouse.wheel(0, -480);                 // the wheel still zooms: the CAD convention
        await page.waitForTimeout(450);
        const zoomed = await pixels(page, '#panes .pane canvas', 'wheel');
        check('gestures: the mouse wheel zooms the model',
              !!zoomed && zoomed.changed !== null && zoomed.changed > 0.02,
              zoomed && (zoomed.changed === null ? 'no first picture'
                                                 : (zoomed.changed * 100).toFixed(2) + '% moved'));

        await page.keyboard.down('Shift');
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - 120, cy - 70, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await page.waitForTimeout(450);
        const slid = await pixels(page, '#panes .pane canvas', 'wheel');
        check('gestures: shift+drag slides the model rather than turning it',
              !!slid && slid.changed !== null && slid.changed > 0.02,
              slid && (slid.changed === null ? 'no picture to compare'
                                              : (slid.changed * 100).toFixed(2) + '% moved'));
        check('gestures: nothing went wrong', problems.length === 0, problems.join(' | '));
        await page.close();
    }

    // 10. A heavy file still paints, and the frame stays responsive while it parses.
    {
        const { page, problems } = await open(browser, base, { sides: { working: b64(HEAVY) } });
        const t0 = Date.now();
        await page.waitForSelector('#panes canvas', { timeout: 60000 });
        await page.waitForFunction(() => /facets/.test(document.getElementById('meta').textContent), null,
                                   { timeout: 60000 });
        const took = Date.now() - t0;
        const seen = await settle(page, 1500);
        check('239k facets: drawn in ' + took + 'ms',
              new RegExp(grouped(HEAVY_FACETS.length) + ' facets').test(seen.meta), seen.meta);
        // Above the parser's limit the edges are never paired, so the line keeps quiet about the shell
        // rather than printing a sentence about its own budget as though the part had a fault.
        check('239k facets: an unchecked shell is not commented on',
              !/shell/i.test(seen.meta), seen.meta);
        check('239k facets: nothing went wrong', problems.length === 0, problems.join(' | '));
        drewSomething(await pixels(page, '#panes .pane canvas'), '239k facets');
        await page.close();
    }
} finally {
    await browser.close();
    server.close();
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
