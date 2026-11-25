// The frame's own script: host handshake, the two sides of a diff, the toolbar, the camera and the gestures,
// all through window.extHost — whose ready() is awaited first, because the config and the grants travel with
// the init message.
//
// Bytes come from fs.getBytes, for this file and a declared suffix only: 'working' is the file as it stands
// and 'base' a diff's old side, and a side that fails to arrive is drawn as nothing.
(function (global) {
    'use strict';

    var host = global.extHost;
    if (!host) return;

    var MODES = ['shaded', 'edges', 'wireframe'];
    var MODE_LABEL = { shaded: 'Shaded', edges: 'Edges', wireframe: 'Wireframe' };
    var DEFAULT_CAP = 1000000;

    // The three planes as buttons: named for what each is to someone looking at the part.
    var PLANE_LABEL = { floor: 'Floor', back: 'Back', side: 'Side' };
    var PLANE_HINT = {
        floor: 'the floor under the model — the XZ plane',
        back: 'the wall behind the model — the XY plane',
        side: 'the wall to one side — the YZ plane'
    };

    var DEFAULT_VIEW = { yaw: 0.62, pitch: 0.4 };   // the three-quarter view, when nothing asks for another
    var ORBIT_PER_PIXEL = 0.011;    // how far a dragged pixel turns the part, in radians
    var MAX_PITCH = 1.55;             // just short of looking straight down the pole
    var MIN_ZOOM = 0.05, MAX_ZOOM = 40;
    var SAME_BYTES = 'both sides hold the same bytes';

    // How tall to ask the host to make the frame: the dialog's own room, and no more. See
    // requestFrameHeight() for where the numbers come from.
    var DIALOG_ROOM = 0.9;            // the dialog holding the frame is capped at 90% of the host viewport
    var DIALOG_CHROME = 118;          // its header (a long path wraps), the body's padding, and slack so
                                      // the body never has to scroll to show what we asked for
    var MIN_FRAME = 320, MAX_FRAME = 1600;
    var CARD_FRAME = 340;             // in the explorer the preview is a card, not a stage
    var UNKNOWN_VIEW = 800;           // assumed when the host's viewport cannot be read at all
    var SAME_BYTES = 'both sides hold the same bytes';
    var view = { yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, zoom: 1, panX: 0, panY: 0 };
    var viewFitted = false;           // the first look is ours; after that the person's own
    var panes = [];
    var sides = [];                   // what the host answered, oldest first: base then working
    var showBefore = true;
    var baseMissing = false;          // the host has no old side; then nothing here mentions one
    var baseSame = '';                // an old side exists and is byte-identical to this one
    var mode = 'shaded';
    var autoRotate = false;
    var maxTriangles = DEFAULT_CAP;
    var drag = null;
    var dirty = true;
    var colours = { background: '#20242b', fill: '#a3b6cc', line: '#d8e2ee' };   // dark theme, until the host's own paint is read

    // What one centimetre is worth in the file's numbers. An STL stores bare figures and never says what they
    // measure, so millimetres — what CAD and 3D printing export in — is assumed, and said on every plane button.
    var UNITS_PER_CM = 10;

    var gridChosen = [];            // the planes drawn now, in the renderer's own order
    var gridTouched = false;        // the person has chosen; the model no longer chooses for them
    var gridPlan = null;            // what the renderer answered for the sides on screen

    var bar = document.getElementById('bar');
    var paneHost = document.getElementById('panes');
    var metaLine = document.getElementById('meta');

    // ---------------------------------------------------------------- small helpers

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function fmtInt(n) {
        if (n === null || n === undefined) return '—';
        return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function fmtBytes(n) {
        if (!n && n !== 0) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    }

    function fmtNum(v) {
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 100000 || a < 0.001) return v.toExponential(2);
        if (a >= 100) return String(Math.round(v));
        return String(Math.round(v * 1000) / 1000);
    }

    function fmtExtents(e) {
        if (!e) return 'no size';
        return fmtNum(e[0]) + ' × ' + fmtNum(e[1]) + ' × ' + fmtNum(e[2]);
    }

    function clampPitch(v) { return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, v)); }

    function clampZoom(v) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v)); }

    // One read of a number that lives on someone else's window, which may be refused outright.
    function readSize(measure) {
        try {
            var v = Math.floor(measure());
            return v > 200 ? v : 0;
        } catch (err) {
            return 0;
        }
    }

    // How tall the host's own window is. The frame is sandboxed and cannot see the box around it, but a
    // window's height is one of the few things readable across that boundary; the display behind it is the
    // next guess, and the last one is a number that is merely too small rather than wrong.
    function hostViewport() {
        return readSize(function () { return global.parent.innerHeight; })
            || readSize(function () { return global.screen.height - 120; })   // minus the browser's chrome
            || UNKNOWN_VIEW;
    }

    var askedHeight = 0;

    // The dialog is `max-height: 90vh` with a scrolling body, and the element this frame is mounted into
    // grows to whatever height we ask for — so ask for the viewport minus the dialog's chrome, and no more.
    function requestFrameHeight() {
        if (!host.setSize) return null;
        var wanted = host.point === 'fileBrowser'
            ? CARD_FRAME
            : Math.max(MIN_FRAME, Math.min(MAX_FRAME, Math.floor(hostViewport() * DIALOG_ROOM) - DIALOG_CHROME));
        if (wanted === askedHeight) return null;
        askedHeight = wanted;
        host.setSize(wanted);
        return null;
    }

    function setMeta(text, warn) {
        metaLine.textContent = text || '';
        metaLine.className = warn ? 'warn' : '';
    }

    function notice(text, warn) {
        paneHost.textContent = '';
        paneHost.appendChild(el('div', 'notice', text));
        setMeta(text, warn !== false);
    }

    // A colour the browser understands, as numbers, via a scratch 2D canvas — the frame is painted from
    // the host's own custom properties and only their resolved values are knowable here.
    function toRGB(color) {
        try {
            var scratch = document.createElement('canvas');
            scratch.width = scratch.height = 1;
            var ctx = scratch.getContext('2d');
            if (!ctx) return null;
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            var d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0], d[1], d[2]];
        } catch (err) {
            return null;
        }
    }

    function hex(rgb) {
        var out = '#';
        for (var i = 0; i < 3; i += 1) {
            var v = Math.max(0, Math.min(255, Math.round(rgb[i]))).toString(16);
            out += v.length === 1 ? '0' + v : v;
        }
        return out;
    }

    // Pick the frame colours from what the host actually painted behind us, so the model reads on a
    // light theme as well as a dark one.
    function pickColours() {
        var background = '#20242b';
        try {
            var resolved = global.getComputedStyle(document.body).backgroundColor;
            var painted = resolved && resolved !== 'transparent' ? toRGB(resolved) : null;
            if (painted) background = hex(painted);
        } catch (err) { /* the fallback stands */ }

        var rgb = toRGB(background);
        var light = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.55 : false;
        colours = {
            background: background,
            fill: light ? '#6f849e' : '#a3b6cc',
            line: light ? '#1a1f26' : '#d8e2ee'
        };
        for (var i = 0; i < panes.length; i += 1) panes[i].viewer.setBackground(colours.background);
        applyGrid();
    }

    // ---------------------------------------------------------------- bytes

    // Reads one side through the host. Resolves to { side, buffer, byteLength }, or { side, error } with
    // the host's own reason in it — which side was refused, and why, is the only clue the person gets.
    function readSide(side) {
        if (!host.fs || typeof host.fs.getBytes !== 'function') {
            return Promise.resolve({ side: side, error: 'the host gave this frame no file reader' });
        }
        return Promise.resolve().then(function () { return host.fs.getBytes(side); })
            .then(function (result) {
                if (!result || !result.blob || typeof result.blob.arrayBuffer !== 'function') {
                    return { side: side, error: 'the host answered without a body' };
                }
                return result.blob.arrayBuffer().then(function (buffer) {
                    return { side: side, buffer: buffer, byteLength: buffer.byteLength };
                });
            })
            .catch(function (err) {
                return { side: side, error: (err && err.message) || String(err) };
            });
    }

    function read(data) { return !!(data && data.buffer); }

    function sideEntry(side) {
        for (var i = 0; i < sides.length; i += 1) if (sides[i].side === side) return sides[i];
        return null;
    }

    function sameBytes(a, b) {
        if (!a || !b || a.byteLength !== b.byteLength) return false;
        var x = new Uint8Array(a.buffer), y = new Uint8Array(b.buffer);
        for (var i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
        return true;
    }

    // Fold a read of the old side into what is on screen: nothing at all when the host has no old side,
    // one note when both sides hold the same bytes, the side itself otherwise. Answers true when the new
    // side still needs parsing.
    function takeBase(result) {
        if (!read(result)) {
            baseMissing = true;
            return false;
        }
        var working = sideEntry('working');
        if (working && sameBytes(result, working.data)) {
            baseSame = SAME_BYTES;
            return false;
        }
        sides.unshift({ side: 'base', data: result });
        baseSame = '';
        return true;
    }

    // ---------------------------------------------------------------- drawing

    function buildBar() {
        bar.textContent = '';
        MODES.forEach(function (name) {
            var button = el('button', null, MODE_LABEL[name]);
            button.type = 'button';
            button.setAttribute('aria-pressed', name === mode ? 'true' : 'false');
            button.addEventListener('click', function () {
                mode = name;
                for (var i = 0; i < panes.length; i += 1) panes[i].viewer.setMode(mode);
                buildBar();
                dirty = true;
            });
            bar.appendChild(button);
        });

        var spin = el('button', null, 'Spin');
        spin.type = 'button';
        spin.setAttribute('aria-pressed', autoRotate ? 'true' : 'false');
        spin.addEventListener('click', function () {
            autoRotate = !autoRotate;
            buildBar();
            dirty = true;
        });
        bar.appendChild(spin);

        var reset = el('button', null, 'Reset view');
        reset.type = 'button';
        reset.title = 'Back to the angle the grid is meant to be read from';
        reset.addEventListener('click', resetView);
        bar.appendChild(reset);

        // Which plane to draw is a question about the part in front of someone — the widest face of a bracket
        // is not the widest face of a gasket — so it is answered beside the part and nowhere else. The order is
        // the renderer's, so the buttons and the drawing never disagree.
        var names = planeNames();
        names.forEach(function (name) {
            var plane = el('button', null, PLANE_LABEL[name] || name);
            plane.type = 'button';
            plane.setAttribute('aria-pressed', gridChosen.indexOf(name) >= 0 ? 'true' : 'false');
            plane.title = (PLANE_HINT[name] || name) + gridHint();
            plane.addEventListener('click', function () {
                var at = gridChosen.indexOf(name);
                if (at >= 0) gridChosen.splice(at, 1);
                else gridChosen.push(name);
                gridChosen = keep(names, gridChosen);
                gridTouched = true;       // the model stops choosing on the person's behalf
                planGrid();
                applyGrid();
                buildBar();
                summarise();
                dirty = true;
            });
            bar.appendChild(plane);
        });

        // The old side is offered rather than demanded where a diff cannot be expected, because asking the
        // read route for it there costs a 404 the browser prints even though this code handles it. Once the
        // host has said there is none, the offer goes too.
        if (showBefore && !sideEntry('base') && !baseMissing && !baseSame) {
            var compare = el('button', null, 'Compare with before');
            compare.type = 'button';
            compare.addEventListener('click', function () {
                compare.textContent = 'asking…';
                readSide('base').then(function (result) {
                    if (!takeBase(result)) { renderSides(); return null; }
                    return parseSide(sideEntry('base')).then(function () {
                        renderSides();
                        return null;
                    });
                });
            });
            bar.appendChild(compare);
        }
        // The toolbar holds controls and nothing else: no file name, because the dialog hosting this frame
        // already titles itself with the file's path.
    }

    function makePane(parsed, label) {
        var pane = el('div', 'pane');
        var canvas = document.createElement('canvas');
        pane.appendChild(canvas);
        if (label) pane.appendChild(el('div', 'cap', label));   // a lone pane needs no caption
        paneHost.appendChild(pane);

        var viewer = global.STLRender.create(canvas, global.THREE, {
            mode: mode,
            background: colours.background,
            color: colours.fill,
            lineColor: colours.line,
            antialias: parsed.triangles <= 500000,
            view: view
        });
        viewer.setMesh(parsed);
        viewer.setGrid(gridSpecFor());
        viewer.resize(canvas.clientWidth, canvas.clientHeight);

        if (global.ResizeObserver) {
            new global.ResizeObserver(function () {
                viewer.resize(canvas.clientWidth, canvas.clientHeight);
                dirty = true;
            }).observe(pane);
        }
        panes.push({ canvas: canvas, viewer: viewer });
    }

    // What the renderer is told to draw, or nothing at all. The same words are sent to every pane, so a
    // diff's two boxes are the same size and made of the same planes.
    function gridSpecFor() {
        return gridPlan ? { spacing: gridPlan.spacing, color: colours.line, planes: gridChosen } : null;
    }

    function planeNames() {
        return (global.STLRender && global.STLRender.planeNames) || ['floor', 'back', 'side'];
    }

    // Hold a choice in the renderer's order, so the buttons and the drawing always list the planes the
    // same way round.
    function keep(order, chosen) {
        return order.filter(function (name) { return chosen.indexOf(name) >= 0; });
    }

    // The first look draws the one plane with the most area — the face a person would naturally draw the part
    // against. Everything else is the buttons' to decide.
    function choosePlanes(extents) {
        var main = global.STLRender && typeof global.STLRender.gridMainPlane === 'function'
            ? global.STLRender.gridMainPlane(extents) : 'floor';
        return main ? [main] : [];
    }

    // The widest of the sides on screen — the one the grid is sized against, so that two panes of a diff
    // are two boxes of the same size and the comparison between them means something.
    function widestExtents() {
        var widest = null;
        for (var i = 0; i < sides.length; i += 1) {
            var e = sides[i].parsed && sides[i].parsed.extents;
            if (!e) continue;
            if (!widest || Math.max(e[0], e[1], e[2]) > Math.max(widest[0], widest[1], widest[2])) widest = e;
        }
        return widest;
    }

    // One square of the planes is one centimetre of the assumed unit, sized against the widest side.
    function planGrid() {
        gridPlan = null;
        if (!sides.length || typeof global.STLRender.gridSpacing !== 'function') return null;
        var widest = widestExtents();
        if (!gridTouched) gridChosen = choosePlanes(widest);
        if (!viewFitted) {
            viewFitted = true;
            suitViewToPlanes();       // the first look suits the grid; a drag afterwards is the person's
        }
        if (!gridChosen.length) return null;
        gridPlan = global.STLRender.gridSpacing(widest, UNITS_PER_CM);
        return gridPlan;
    }

    function applyGrid() {
        var spec = gridSpecFor();
        for (var i = 0; i < panes.length; i += 1) panes[i].viewer.setGrid(spec);
    }

    // A centimetre count in the unit someone would actually say out loud.
    function gridLabel(cm) {
        if (!(cm > 0)) return 'off';
        if (cm < 1) return fmtNum(cm * 10) + ' mm';
        if (cm < 100) return fmtNum(cm) + ' cm';
        if (cm < 10000) return fmtNum(cm / 100) + ' m';
        return fmtNum(cm / 100000) + ' km';
    }

    // What one square measures and what unit it is read in, on the plane buttons rather than under the view,
    // which is the model's own line; a square other than one centimetre says why.
    function gridHint() {
        if (!gridPlan) return '';
        var hint = ' · 1 square = ' + gridLabel(gridPlan.cm) + ' (1 unit = 1 mm)';
        if (gridPlan.reason === 'coarse') hint += ': 1 cm would need ' + fmtInt(gridPlan.at1cm) + ' lines';
        else if (gridPlan.reason === 'fine') {
            hint += ': the model is ' + fmtNum(gridPlan.span / UNITS_PER_CM) + ' cm across';
        }
        return hint;
    }

    // The pose the grid is read from, taken for the first look and by 'Reset view' — a wall met at 41°
    // shears its squares into a hatch. Choosing a plane does not move the camera: by then the orbit belongs
    // to the person looking.
    function suitViewToPlanes() {
        var pose = (global.STLRender && typeof global.STLRender.gridView === 'function')
            ? global.STLRender.gridView(gridChosen) : null;
        view.yaw = pose ? pose.yaw : DEFAULT_VIEW.yaw;
        view.pitch = pose ? pose.pitch : DEFAULT_VIEW.pitch;
    }

    function resetView() {
        suitViewToPlanes();
        view.zoom = 1;
        view.panX = 0;
        view.panY = 0;
        dirty = true;
    }

    // Whether every edge is shared by two facets — the fact that decides whether the part will slice and
    // print. Not looking is left unsaid; `explain` spells out the open case, the only bad news the line
    // carries.
    function shellWord(parsed, explain) {
        if (parsed.manifold === true) return 'closed shell';
        if (parsed.manifold !== false) return '';
        return explain ? 'open shell — some edges belong to one facet' : 'open shell';
    }

    // What the line says about one side — the model, not its container: the byte count already tells you an
    // ASCII export is bulky, and anything wrong with the file arrives as a note instead.
    function describe(parsed) {
        var bits = [fmtInt(parsed.triangles) + ' facets', fmtBytes(parsed.byteLength),
                    fmtExtents(parsed.extents)];
        var shell = shellWord(parsed, true);
        if (shell) bits.push(shell);
        return bits.join(' · ');
    }

    function summarise() {
        // About the model, not the file: the dialog hosting this frame titles itself with the file's
        // path, so the name is said once — by the dialog, never here.
        var parts = [];

        if (sides.length === 2) {
            var before = sides[0].parsed, after = sides[1].parsed;
            var delta = after.triangles - before.triangles;
            parts.push('before ' + fmtInt(before.triangles) + ' facets');
            parts.push('after ' + fmtInt(after.triangles) + ' facets' +
                       (delta === 0 ? ' (same count)' : ' (' + (delta > 0 ? '+' : '−') + fmtInt(Math.abs(delta)) + ')'));
            parts.push(fmtExtents(after.extents));
            var shell = shellWord(after, true);
            if (shell) {
                parts.push(shell + (before.manifold !== after.manifold ? ' (was ' + shellWord(before) + ')' : ''));
            }
        } else {
            parts.push(describe(sides[0].parsed));
        }

        var notes = [];
        if (baseSame) notes.push(baseSame);
        for (var i = 0; i < sides.length; i += 1) {
            var list = sides[i].parsed.notes || [];
            for (var j = 0; j < list.length; j += 1) {
                notes.push((sides.length === 2 ? sides[i].label + ': ' : '') + list[j]);
            }
        }
        var text = parts.join(' · ');
        setMeta(notes.length ? text + ' — ' + notes.join('; ') : text, notes.length > 0);
    }

    // ------------------------------------------------------------- the gestures
    //
    // One finger turns the part, two pinch to zoom and slide together to move it, and the wheel zooms — the
    // CAD convention, left alone. Shift+drag moves the part with a mouse, which has no second finger; a slide
    // never tilts it, because stl-render.js slides the camera with its own look-at point.

    var pointers = new Map();     // id -> { x, y }: the fingers on the pane right now
    var spread = null;            // the two-finger gesture in progress, rebased on every move

    // How tall the picture is being drawn into, which is what turns a dragged pixel into a fraction of the
    // visible half-height. The canvas knows best; before the first pane exists the pane host will do.
    function paneHeight() {
        var canvas = panes.length ? panes[0].canvas : null;
        return (canvas && canvas.clientHeight) || paneHost.clientHeight || 200;
    }

    function fingerList() {
        var list = [];
        pointers.forEach(function (finger) { list.push(finger); });
        return list;
    }

    // A slide is written as a fraction of the visible half-height, which is how the renderer wants it and
    // why the same drag moves the part the same number of screen pixels however close it is fitted. Screen
    // y grows downwards and world y upwards, so one of the two signs is flipped.
    function panBy(dx, dy) {
        var half = paneHeight();
        view.panX -= 2 * dx / half;
        view.panY += 2 * dy / half;
    }

    function spreadOf(fingers) {
        return {
            span: Math.max(1, Math.sqrt(Math.pow(fingers[0].x - fingers[1].x, 2) +
                                        Math.pow(fingers[0].y - fingers[1].y, 2))),
            x: (fingers[0].x + fingers[1].x) / 2,
            y: (fingers[0].y + fingers[1].y) / 2
        };
    }

    function beginSpread() {
        var fingers = fingerList();
        if (fingers.length < 2) return null;
        var start = spreadOf(fingers);
        start.zoom = view.zoom;
        return start;
    }

    // Spreading the fingers zooms, and moving them both together slides — both at once, because that is
    // what a hand does. Each move is measured from the last one rather than from where the gesture began,
    // so a long pinch cannot drift or compound.
    function moveSpread() {
        var fingers = fingerList();
        if (fingers.length < 2) return;
        var now = spreadOf(fingers);
        view.zoom = clampZoom(spread.zoom * now.span / spread.span);
        panBy(now.x - spread.x, now.y - spread.y);
        spread.span = now.span;
        spread.x = now.x;
        spread.y = now.y;
        spread.zoom = view.zoom;
        dirty = true;
    }

    function beginDrag(event) {
        drag = event.shiftKey
            ? { pan: true, x: event.clientX, y: event.clientY }
            : { pan: false, x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
    }

    // ------------------------------------------------------- interaction + the loop

    function bindControls() {
        paneHost.addEventListener('pointerdown', function (event) {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointers.size >= 2) {
                // A second finger freezes the orbit rather than ending it: the view must not jump as the
                // gesture starts, and lifting back to one finger carries on from the angle it left.
                drag = null;
                spread = beginSpread();
            } else {
                spread = null;
                beginDrag(event);
            }
            paneHost.classList.add('dragging');
            if (paneHost.setPointerCapture) {
                try { paneHost.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
            }
            paneHost.focus();
            event.preventDefault();
        });
        paneHost.addEventListener('pointermove', function (event) {
            var finger = pointers.get(event.pointerId);
            if (!finger) return;            // a hover, or a finger that was already lifted
            var dx = event.clientX - finger.x, dy = event.clientY - finger.y;
            finger.x = event.clientX;
            finger.y = event.clientY;
            if (pointers.size >= 2) {
                if (spread) moveSpread();
                return;
            }
            if (!drag) return;
            if (drag.pan) {
                panBy(dx, dy);
                dirty = true;
                return;
            }
            view.yaw = drag.yaw + (event.clientX - drag.x) * ORBIT_PER_PIXEL;
            view.pitch = clampPitch(drag.pitch + (event.clientY - drag.y) * ORBIT_PER_PIXEL);
            dirty = true;
        });
        function release(event) {
            pointers.delete(event.pointerId);
            // Two fingers left means the pinch goes on with the ones that stayed, so its baseline is taken
            // from where they are now rather than from where three fingers were.
            if (pointers.size === 2) spread = beginSpread();
            else if (pointers.size < 2) spread = null;
            if (pointers.size === 1) {
                // The finger that stayed has been moving all along, so its last place is the new reference
                // and the orbit resumes without a snap.
                var only = fingerList()[0];
                drag = { pan: false, x: only.x, y: only.y, yaw: view.yaw, pitch: view.pitch };
                return;
            }
            drag = null;
            paneHost.classList.remove('dragging');
        }
        paneHost.addEventListener('pointerup', release);
        paneHost.addEventListener('pointercancel', release);
        paneHost.addEventListener('dblclick', resetView);
        paneHost.addEventListener('wheel', function (event) {
            event.preventDefault();
            view.zoom = clampZoom(view.zoom * Math.exp(-event.deltaY * 0.0012));
            dirty = true;
        }, { passive: false });
        paneHost.addEventListener('keydown', function (event) {
            var nudge = event.shiftKey ? 0.25 : 0.08, used = true;
            if (event.key === 'ArrowLeft') view.yaw -= nudge;
            else if (event.key === 'ArrowRight') view.yaw += nudge;
            else if (event.key === 'ArrowUp') view.pitch = clampPitch(view.pitch - nudge);
            else if (event.key === 'ArrowDown') view.pitch = clampPitch(view.pitch + nudge);
            else if (event.key === '+' || event.key === '=') view.zoom = clampZoom(view.zoom * 1.2);
            else if (event.key === '-' || event.key === '_') view.zoom = clampZoom(view.zoom / 1.2);
            else if (event.key === 'r' || event.key === 'R') resetView();
            else used = false;
            if (used) { event.preventDefault(); dirty = true; }
        });

        global.addEventListener('resize', function () {
            for (var i = 0; i < panes.length; i += 1) {
                panes[i].viewer.resize(panes[i].canvas.clientWidth, panes[i].canvas.clientHeight);
            }
            requestFrameHeight();
            dirty = true;
        });

        if (host.on) {
            host.on('theme.update', function () { pickColours(); dirty = true; });
        }
    }

    var ticks = 0;

    function loop() {
        if (autoRotate && !drag && pointers.size === 0) { view.yaw += 0.006; dirty = true; }
        // A resized browser window changes the dialog's ceiling but says nothing to this frame, so the
        // height is looked at again every second or so. Asking again is silent unless the number moved.
        if ((ticks += 1) % 60 === 0) requestFrameHeight();
        if (dirty) {
            dirty = false;
            for (var i = 0; i < panes.length; i += 1) panes[i].viewer.render();
        }
        global.requestAnimationFrame(loop);
    }

    // ---------------------------------------------------------------- start

    function parseSide(entry) {
        return global.STLParse.parse(entry.data.buffer, { maxTriangles: maxTriangles })
            .then(function (parsed) {
                parsed.byteLength = entry.data.byteLength;
                entry.parsed = parsed;
                return entry;
            });
    }

    // Both panes are rebuilt from `sides` — bringing the old side in later from the button takes the same
    // path as the automatic diff: one renderer per pane, rebuilt rather than patched.
    function renderSides() {
        for (var i = 0; i < panes.length; i += 1) {
            try { panes[i].viewer.dispose(); } catch (err) { /* the context is already gone */ }
        }
        panes = [];
        paneHost.textContent = '';
        var two = sides.length === 2;
        planGrid();
        for (var j = 0; j < sides.length; j += 1) {
            var entry = sides[j];
            // A caption tells two panes apart. With one pane the only word left would be the read route's
            // own name for the byte source — 'working' — which is API vocabulary, not the person's.
            entry.label = two ? (entry.side === 'base' ? 'before' : 'after') : '';
            makePane(entry.parsed, entry.label);
        }
        buildBar();
        summarise();
        dirty = true;
    }

    host.ready().then(function () {
        var config = host.config || {};
        var wanted = String(config.render_mode || '').trim().toLowerCase();
        mode = MODES.indexOf(wanted) >= 0 ? wanted : 'shaded';
        var cap = Math.floor(Number(config.max_triangles));
        maxTriangles = cap > 0 ? cap : DEFAULT_CAP;
        autoRotate = config.auto_rotate === true || config.auto_rotate === 'true';
        showBefore = config.show_before !== false && config.show_before !== 'false';
        gridChosen = [];
        gridTouched = false;

        // A diff exists only where a task's changes are shown, which the mount says through its context.
        // Elsewhere the old side is a button, since the read route answers 404 for a side that is not there.
        var autoBase = showBefore && !!(host.context && host.context.taskId);

        pickColours();
        setMeta('reading…');
        // Claim the room before the bytes are read, so the dialog stops growing while the model is still
        // arriving rather than after it appears.
        requestFrameHeight();

        return readSide('working').then(function (working) {
            if (read(working)) {
                sides.push({ side: 'working', data: working });
            } else if (!host.context || !host.context.filePath) {
                // In the explorer the frame can be mounted before a file is chosen: say nothing loudly.
                if (host.hide) host.hide();
                else setMeta('no file to preview', true);
                return null;
            } else {
                // The file itself was refused: asking for the old side after that is a second 404 over
                // the same problem.
                throw new Error('no bytes — ' + working.error);
            }
            return autoBase ? readSide('base') : null;
        }).then(function (base) {
            if (base) takeBase(base);
            if (!sides.length) return null;
            return Promise.all(sides.map(parseSide));
        }).then(function (parsed) {
            if (!parsed) return null;
            if (!parsed.some(function (entry) { return entry.parsed.triangles > 0; })) {
                throw new Error('the file holds no facets');
            }
            if (!global.THREE) throw new Error('three.min.js did not load');
            if (!global.STLRender.available()) {
                notice('This browser gave no WebGL context, so the model cannot be drawn.');
                return null;
            }

            renderSides();
            bindControls();
            loop();
            return null;
        });
    }).catch(function (err) {
        var message = (err && err.message) || String(err);
        notice(message, true);
        if (host.error) host.error(message);
    });
}(typeof globalThis !== 'undefined' ? globalThis : this));
