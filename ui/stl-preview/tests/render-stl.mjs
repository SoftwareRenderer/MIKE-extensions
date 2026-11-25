// The renderer's own test, without a GPU: stl-render.js is driven against a three.js stand-in shaped like
// three.js, so the wiring here — the fit, the camera, the three draw modes, the context loss — is checked, and
// what is left to the browser is only whether three.js and the driver paint it (tests/README.md: the default
// image has neither node nor a browser).

//   node tests/render-stl.mjs       exits non-zero on the first failure
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, '..', 'stl-render.js'), 'utf8');

let failed = 0;
function check(name, condition, detail) {
    if (condition) console.log('ok   ' + name);
    else { failed += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' (' + detail + ')')); }
}
const near = (a, b, epsilon = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= epsilon;

// How squarely a plane is met from a pose: the camera looks down -Z and the model turns under it as
// R = Ry(yaw)·Rx(pitch), so it is the z component of the plane's rotated normal. Spelled out rather than
// borrowed from three.js — and checked against the vendored build below, so the convention is not assumed.
const MEET = { floor: (y, p) => Math.sin(p) * Math.cos(y),      // its normal is the model's +Y
               back:  (y, p) => Math.cos(p) * Math.cos(y),      // … +Z
               side:  (y, p) => -Math.sin(y) };                 // … +X

function vec() {
    return { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
}

function makeTHREE(sink) {
    class Vector3like { constructor() { this.value = 1; } setScalar(v) { this.value = v; } }
    return {
        DoubleSide: 2,
        Color: function (value) { this.value = value; sink.colors.push(value); },
        WebGLRenderer: function (options) {
            sink.renderers.push(this);
            this.domElement = options.canvas;
            this.setSize = (w, h, updateStyle) => sink.sizes.push([w, h, updateStyle]);
            this.setPixelRatio = (r) => sink.ratios.push(r);
            this.setClearColor = (c, a) => sink.clears.push([c && c.value, a]);
            this.render = (scene, camera) => sink.renders.push([scene, camera]);
            this.dispose = () => { sink.disposed += 1; };
        },
        Scene: function () {
            this.children = [];
            this.add = (...c) => { c.forEach((k) => { k.__parent = this; }); this.children.push(...c); };
            this.remove = (...c) => { this.children = this.children.filter((k) => c.indexOf(k) < 0); };
        },
        PerspectiveCamera: function (fov, aspect, near_, far) {
            sink.cameras.push(this);
            this.fov = fov; this.aspect = aspect; this.near = near_; this.far = far;
            this.position = vec(); this.updates = 0; this.target = null;
            this.updateProjectionMatrix = () => { this.updates += 1; };
            this.lookAt = (x, y, z) => { this.looked = true; this.target = [x, y, z]; };
        },
        Group: function () {
            this.children = []; this.rotation = { order: '', y: 0, x: 0, z: 0 };
            this.scale = new Vector3like();
            this.add = (...c) => { c.forEach((k) => { k.__parent = this; }); this.children.push(...c); };
            this.remove = (...c) => { this.children = this.children.filter((k) => c.indexOf(k) < 0); };
        },
        HemisphereLight: function () {},
        DirectionalLight: function () { this.position = vec(); },
        BufferGeometry: function () {
            this.attributes = {}; this.disposed = 0; this.boundingSphere = null;
            this.setAttribute = (name, value) => { this.attributes[name] = value; };
            this.computeBoundingSphere = function () {
                const a = this.attributes.position.array;
                const b = vec();
                for (let i = 0; i < a.length; i += 3) {
                    b.x = Math.max(b.x, Math.abs(a[i]));
                    b.y = Math.max(b.y, Math.abs(a[i + 1]));
                    b.z = Math.max(b.z, Math.abs(a[i + 2]));
                }
                this.boundingSphere = { radius: Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z) };
            };
            this.dispose = function () { this.disposed += 1; };
        },
        BufferAttribute: function (array, itemSize) { this.array = array; this.itemSize = itemSize; },
        LineSegments: function (geometry, material) {
            sink.lines.push(this);
            this.geometry = geometry; this.material = material; this.frustumCulled = true;
        },
        LineBasicMaterial: function (options) {
            Object.assign(this, options); this.dispose = () => { sink.disposed += 1; };
        },
        Mesh: function (geometry, material) {
            this.geometry = geometry; this.material = material; this.visible = true; this.frustumCulled = true;
        },
        MeshLambertMaterial: function (options) { Object.assign(this, options); this.dispose = () => { sink.disposed += 1; }; },
        MeshBasicMaterial: function (options) { Object.assign(this, options); this.dispose = () => { sink.disposed += 1; }; }
    };
}

function canvasStub() {
    return {
        clientWidth: 300, clientHeight: 200, listeners: {},
        addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
        getContext: (kind) => (kind === 'webgl' ? {} : null)
    };
}

// A 2 × 1 × 1 box's worth of two triangles, off-centre so the fit has something to do.
const parsed = {
    triangles: 2,
    positions: new Float32Array([
        1, 0, 0, 3, 0, 0, 3, 1, 0,
        1, 0, 0, 3, 1, 0, 1, 1, 0
    ]),
    center: [2, 0.5, 0],
    extents: [2, 1, 0],
    manifold: false,
    notes: []
};

// A real 20 × 10 × 5 box standing at z = 10, off the origin so every plane has a number to sit on and the
// fit has extents to reason about. Built fresh each call: setMesh centres the numbers in place, so a model
// handed to it twice would be centred twice.
function boxModel() {
    const lo = [100, 50, 10], hi = [120, 60, 15];
    const corners = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
    const faces = [[0,1,3],[0,3,2],[4,6,7],[4,7,5],[0,4,5],[0,5,1],[2,3,7],[2,7,6],[0,2,6],[0,6,4],[1,5,7],[1,7,3]];
    return {
        triangles: faces.length,
        positions: new Float32Array(faces.reduce((acc, f) => acc.concat(corners[f[0]], corners[f[1]], corners[f[2]]), [])),
        center: [110, 55, 12.5], min: lo, max: hi,
        extents: [20, 10, 5], manifold: true, notes: []
    };
}

function boot() {
    const sink = { colors: [], renderers: [], cameras: [], sizes: [], ratios: [], clears: [], renders: [],
                   lines: [], disposed: 0 };
    const THREE = makeTHREE(sink);
    const sandbox = { THREE, document: { createElement: canvasStub }, devicePixelRatio: 3, console,
                      setTimeout, clearTimeout, TextDecoder };
    const context = vm.createContext(sandbox);
    vm.runInContext(SOURCE, context, { filename: 'stl-render.js' });
    const canvas = canvasStub();
    const view = { yaw: 0.5, pitch: 0.25, zoom: 1 };
    const viewer = context.STLRender.create(canvas, THREE, { mode: 'shaded', background: '#101418', view: view });
    return { THREE, sink, canvas, view, viewer, STLRender: context.STLRender };
}

// 1. The fit: the model is centred on its own middle and scaled to a unit sphere, so one camera
//    distance suits any part in any units.
{
    const t = boot();
    t.viewer.setMesh(parsed);
    check('renderer: one WebGL renderer', t.sink.renderers.length === 1, t.sink.renderers.length);

    // Centre the numbers: the two triangles now straddle the origin.
    const pos = parsed.positions;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
        minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
        minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
    }
    check('fit: the model was centred', near(minX, -1, 1e-5) && near(maxX, 1, 1e-5) &&
                                     near(minY, -0.5, 1e-5) && near(maxY, 0.5, 1e-5),
          JSON.stringify([minX, maxX, minY, maxY]));
}

// 2. The camera: distance is the fitted radius over the half-FOV, and zoom only dollies.
{
    const t = boot();
    t.viewer.setMesh(parsed);
    t.viewer.render();
    const camera = t.sink.renders[0][1];
    const expected = (1 / Math.tan(22.5 * Math.PI / 180)) * 1.18;
    check('camera: sits at the fitted distance', near(camera.position.z, expected, 1e-9), camera.position.z);
    check('camera: looks at the model', camera.looked === true);

    t.view.zoom = 4;
    t.viewer.render();
    check('camera: zoom dollies', near(t.sink.renders[1][1].position.z, expected / 4, 1e-9),
          t.sink.renders[1][1].position.z);

    t.view.zoom = 0;                       // a nonsense zoom must not put the camera at infinity
    t.viewer.render();
    check('camera: a broken zoom falls back to 1',
          near(t.sink.renders[2][1].position.z, expected, 1e-9), t.sink.renders[2][1].position.z);
}

// 2c. The pan. Sliding the camera along with its own look-at point moves the part without tilting it, which
//     is the whole difference between sliding a model and dragging it round.
{
    const t = boot();
    t.viewer.setMesh(parsed);
    t.viewer.resize(400, 200);
    t.viewer.render();
    const still = t.sink.renders[0][1];
    const distance = still.position.z;
    check('pan: with no pan the camera sits on the model',
          still.position.x === 0 && still.position.y === 0 &&
          JSON.stringify(still.target) === '[0,0,0]',
          JSON.stringify([still.position.x, still.position.y, still.target]));

    t.view.panX = 0.5;
    t.view.panY = -0.25;
    t.viewer.render();
    const moved = t.sink.renders[1][1];
    const half = distance * Math.tan(22.5 * Math.PI / 180);
    check('pan: the camera slides by that fraction of the visible half-height',
          near(moved.position.x, 0.5 * half, 1e-9) && near(moved.position.y, -0.25 * half, 1e-9),
          JSON.stringify([moved.position.x, moved.position.y]));
    check('pan: it still looks straight down -Z, so the part is slid and not tilted',
          near(moved.target[0] - moved.position.x, 0, 1e-9) &&
          near(moved.target[1] - moved.position.y, 0, 1e-9) &&
          near(moved.target[2] - moved.position.z, -distance, 1e-9),
          JSON.stringify([moved.position, moved.target]));
    check('pan: the distance is untouched, so sliding never zooms',
          near(moved.position.z, distance, 1e-9), moved.position.z);

    // A diff's two panes are handed the one view object, which is what makes them slide together.
    const other = t.STLRender.create(canvasStub(), t.THREE, { mode: 'shaded', view: t.view });
    other.setMesh(boxModel());
    other.render();
    const also = t.sink.renders[t.sink.renders.length - 1][1];
    const otherHalf = also.position.z * Math.tan(22.5 * Math.PI / 180);
    check('pan: two panes holding one view slide together',
          near(also.position.x, 0.5 * otherHalf, 1e-9) && near(also.position.y, -0.25 * otherHalf, 1e-9),
          JSON.stringify([also.position.x, also.position.y]));
}

// 2b. The pane's shape, not only its height, decides how far back the camera sits: a pane taller than it is wide
//     has less room left and right than above and below, and fitting the height alone — which this once did —
//     cut the part off at the sides. That is every pane of a diff, and every frame the dialog stretched tall.
{
    const TAN = Math.tan(22.5 * Math.PI / 180);
    const fitFor = (aspect, planes) => {
        const t = boot();
        t.viewer.setMesh(boxModel());
        if (planes) t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes });
        t.viewer.resize(200 * aspect, 200);
        t.viewer.render();
        return { distance: t.sink.renders[t.sink.renders.length - 1][1].position.z,
                 info: t.viewer.gridInfo() };
    };

    const wide = fitFor(2.5), square = fitFor(1), narrow = fitFor(0.5);
    check('pane shape: a wide pane is still fitted by its height',
          near(wide.distance, 1.18 / TAN, 1e-9), wide.distance);
    check('pane shape: a square pane agrees with it',
          near(square.distance, 1.18 / TAN, 1e-9), square.distance);
    check('pane shape: a narrow pane backs off rather than halving the part',
          near(narrow.distance, 1.18 / (TAN * 0.5), 1e-9), narrow.distance);
    check('pane shape: the part fits inside whichever angular extent is tighter',
          [[2.5, wide], [1, square], [0.5, narrow]].every(([aspect, f]) =>
              1 / f.distance <= TAN * Math.min(1, aspect) + 1e-9),
          JSON.stringify([wide.distance, square.distance, narrow.distance]));

    // A plane stands outside the part, so the fit reaches past the part too — bounded, because a part
    // leaning against two walls is no reason to draw the part itself at three-quarters size.
    const bare = fitFor(2.5), walled = fitFor(2.5, ['floor', 'back', 'side']);
    check('pane shape: drawing the planes widens the fit',
          bare.info === null && walled.info.fit > 1, JSON.stringify(walled.info && walled.info.fit));
    check('pane shape: the distance grows with it',
          near(walled.distance, 1.18 * walled.info.fit / TAN, 1e-9), walled.distance);
    check('pane shape: and stops at the bound, so the part is not shrunk away',
          walled.info.fit === 1.3, walled.info.fit);
    check('pane shape: putting the planes away takes the extra room back',
          (() => {
              const t = boot();
              t.viewer.setMesh(boxModel());
              t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['back'] });
              t.viewer.setGrid(null);
              t.viewer.resize(500, 200);
              t.viewer.render();
              return t.viewer.gridInfo() === null && near(t.sink.renders[0][1].position.z, 1.18 / TAN, 1e-9);
          })(),
          'a pane with no planes should sit at the part-only distance');
}

// 3. The three draw modes are the two meshes over one geometry, not three geometries.
{
    const t = boot();
    t.viewer.setMesh(parsed);
    t.viewer.render();
    const scene = t.sink.renders[0][0];
    const pivot = scene.children[0];
    const meshes = pivot.children;
    check('modes: one pivot holds two meshes', meshes.length === 2, meshes.length);
    check('modes: both share one geometry', meshes[0].geometry === meshes[1].geometry);

    t.viewer.setMode('shaded');
    check('modes: shaded shows the solid only', meshes[0].visible && !meshes[1].visible);
    t.viewer.setMode('edges');
    check('modes: edges shows both', meshes[0].visible && meshes[1].visible);
    check('modes: edges keeps the lines faint', near(meshes[1].material.opacity, 0.3, 1e-9), meshes[1].material.opacity);
    t.viewer.setMode('wireframe');
    check('modes: wireframe drops the solid', !meshes[0].visible && meshes[1].visible);
    check('modes: wireframe hardens the lines', near(meshes[1].material.opacity, 0.85, 1e-9), meshes[1].material.opacity);
    check('modes: the solid is lit flat and unculled',
          meshes[0].material.flatShading === true && meshes[0].material.side === t.THREE.DoubleSide &&
          meshes[0].frustumCulled === false);
}

// 4. Resizing sets the drawing buffer and the aspect, and caps the pixel ratio at 2.
{
    const t = boot();
    t.viewer.resize(400, 200);
    check('resize: buffer follows the pane',
          t.sink.sizes.length === 1 && t.sink.sizes[0][0] === 400 && t.sink.sizes[0][1] === 200,
          JSON.stringify(t.sink.sizes));
    check('resize: aspect recomputed',
          near(t.sink.cameras[0].aspect, 2, 1e-9) && t.sink.cameras[0].updates >= 1,
          t.sink.cameras[0].aspect + ' / ' + t.sink.cameras[0].updates);
    check('resize: device pixel ratio capped', t.sink.ratios[t.sink.ratios.length - 1] === 2,
          JSON.stringify(t.sink.ratios));
    t.sink.sizes.length = 0;
    t.canvas.clientWidth = 0; t.canvas.clientHeight = 0;
    t.viewer.resize(0, 0);
    check('resize: a pane with no size still gets one pixel',
          t.sink.sizes[0][0] === 1 && t.sink.sizes[0][1] === 1, JSON.stringify(t.sink.sizes[0]));
}

// 5. Losing the context stops the drawing instead of throwing on every frame.
{
    const t = boot();
    t.viewer.setMesh(parsed);
    check('context: alive to start with', t.viewer.isLost() === false);
    const lost = t.canvas.listeners.webglcontextlost[0];
    let prevented = false;
    lost({ preventDefault() { prevented = true; } });
    check('context: the loss was swallowed, not thrown', prevented === true);
    check('context: reported lost', t.viewer.isLost() === true);
    const before = t.sink.renders.length;
    t.viewer.render();
    check('context: nothing more is drawn', t.sink.renders.length === before, t.sink.renders.length - before);
    t.viewer.dispose();
    check('dispose: released the renderer', t.sink.disposed >= 1, t.sink.disposed);
}

// 6. A machine with no WebGL is answered with a plain no, not an exception.
{
    const t = boot();
    const blocked = { createElement: () => ({ getContext: () => null, addEventListener() {} }) };
    const sandbox = { THREE: t.THREE, document: blocked, console, setTimeout, clearTimeout, TextDecoder };
    const context = vm.createContext(sandbox);
    vm.runInContext(SOURCE, context, { filename: 'stl-render.js' });
    check('available: says no when the browser gives no context', context.STLRender.available() === false);

    const openBox = { createElement: () => ({ getContext: () => ({ getExtension: () => null }), addEventListener() {} }) };
    const sandbox2 = { THREE: t.THREE, document: openBox, console, setTimeout, clearTimeout, TextDecoder };
    const context2 = vm.createContext(sandbox2);
    vm.runInContext(SOURCE, context2, { filename: 'stl-render.js' });
    check('available: says yes when one is handed over', context2.STLRender.available() === true);
}

// 7. The vendored build: the names stl-render.js reaches for are the ones in three.min.js. This is the
//    guard against swapping the vendored file for a build that dropped one of them — the load never
//    checks a script the manifest does not name, so a missing class would only show up as a blank pane.
{
    const THREE_SRC = fs.readFileSync(path.join(here, '..', 'three.min.js'), 'utf8');
    const surface = ['WebGLRenderer', 'Scene', 'PerspectiveCamera', 'Group', 'HemisphereLight',
                     'DirectionalLight', 'BufferGeometry', 'BufferAttribute', 'Mesh',
                     'MeshLambertMaterial', 'MeshBasicMaterial', 'LineSegments', 'LineBasicMaterial',
                     'Color', 'DoubleSide'];
    const sandbox = {
        console, setTimeout, clearTimeout, TextDecoder, URL, Image: function () {},
        navigator: { userAgent: 'node' }
    };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.document = {
        createElement: () => ({ style: {}, getContext: () => null }),
        createElementNS: () => ({ style: {}, getContext: () => null })
    };
    const context = vm.createContext(sandbox);
    let loaded = true, loadError = '';
    try {
        vm.runInContext(THREE_SRC, context, { filename: 'three.min.js' });
    } catch (err) {
        loaded = false; loadError = err.message;
    }
    check('vendored three.js loads as a script (no import, no fetch)', loaded, loadError);
    if (loaded) {
        const T = context.THREE;
        check('vendored three.js: the surface stl-render.js uses is all there',
              surface.every((name) => T[name] !== undefined),
              surface.filter((name) => T[name] === undefined).join(', '));
        check('vendored three.js: the revision is pinned in the test', T.REVISION === '149', T.REVISION);
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
        geometry.computeBoundingSphere();
        check('vendored three.js: the fit reads a radius off the geometry',
              near(geometry.boundingSphere.radius, Math.SQRT1_2, 1e-4), geometry.boundingSphere.radius);
        const lambert = new T.MeshLambertMaterial({ color: new T.Color('#9fb2c9'), flatShading: true, side: T.DoubleSide });
        const basic = new T.MeshBasicMaterial({ color: new T.Color('#0d1117'), wireframe: true, opacity: 0.3 });
        check('vendored three.js: flat shading and the wireframe pass are honoured',
              lambert.flatShading === true && lambert.side === T.DoubleSide &&
              basic.wireframe === true && basic.opacity === 0.3);
        const group = new T.Group();
        group.rotation.order = 'YXZ';
        group.scale.setScalar(4);
        check('vendored three.js: the pivot turns and scales as assumed',
              group.rotation.order === 'YXZ' && group.scale.x === 4, group.scale.x);
        // The poses the grid asks for are written against one Euler convention; this says the vendored
        // build reads them the same way, so a pose measured here is the pose the browser will take.
        const poses = boot().STLRender;
        [['floor', [0, 1, 0]], ['back', [0, 0, 1]], ['side', [1, 0, 0]]].forEach(([name, normal]) => {
            const pose = poses.gridView([name]);
            const turned = new T.Vector3(normal[0], normal[1], normal[2])
                .applyEuler(new T.Euler(pose.pitch, pose.yaw, 0, 'YXZ'));
            check('vendored three.js: ' + name + '\'s pose means the turn this file measures it as',
                  Math.abs(turned.z - MEET[name](pose.yaw, pose.pitch)) < 1e-9,
                  'three says ' + turned.z.toFixed(4) + ', the trig says ' +
                  MEET[name](pose.yaw, pose.pitch).toFixed(4));
        });
        // The grid, built the way stl-render.js builds it, out of the vendored build's own parts.
        const gridGeometry = new T.BufferGeometry();
        gridGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(12), 3));
        const gridMaterial = new T.LineBasicMaterial({
            color: new T.Color('#8fa0b5'), transparent: true, opacity: 0.55, depthWrite: false });
        const floor = new T.Group();
        const lines = new T.LineSegments(gridGeometry, gridMaterial);
        floor.add(lines);
        check('vendored three.js: the grid is built from parts three itself accepts',
              lines.type === 'LineSegments' && floor.children.length === 1 &&
              gridMaterial.opacity === 0.55 && gridMaterial.depthWrite === false &&
              lines.frustumCulled === true, lines.type + '/' + floor.children.length);
    }
}

// 8. The reference grid: one square is one centimetre of the declared unit, the floor lies under the
//    model's own underside, and a part far from a centimetre's scale gets a usable square instead of an
//    absurd one — with the reason kept rather than the grid quietly changed.
{
    const { STLRender } = boot();
    const mm = 10;                                      // ten model units to the centimetre

    const one = STLRender.gridSpacing([30, 85, 29.6], mm);
    check('grid: 1 cm is what is asked for and what is drawn',
          one.cm === 1 && one.spacing === 10 && one.reason === '', JSON.stringify(one));

    const wide = STLRender.gridSpacing([12000, 30, 30], mm);  // a 12 m part read as millimetres
    check('grid: a huge part coarsens by decades rather than drowning',
          wide.reason === 'coarse' && wide.cm === 100 && wide.spacing === 1000 && wide.lines <= 120,
          JSON.stringify(wide));
    check('grid: the coarsening says what 1 cm would have cost', wide.at1cm === 1201, wide.at1cm);

    const small = STLRender.gridSpacing([20, 10, 5], mm);      // a 2 cm part
    check('grid: a part under a few centimetres gets a finer square',
          small.reason === 'fine' && small.cm === 0.1 && small.spacing === 1, JSON.stringify(small));

    const asCm = STLRender.gridSpacing([30, 85, 29.6], 1);     // the file drawn in centimetres
    check('grid: the declared unit moves the square, not the label',
          asCm.cm === 1 && asCm.spacing === 1, JSON.stringify(asCm));

    const tall = STLRender.gridSpacing([30, 12000, 30], mm);    // same part stood on its end
    check('grid: the walls count too, so a tall part coarsens as a wide one does',
          tall.reason === 'coarse' && tall.spacing === 1000, JSON.stringify(tall));

    check('grid: nothing to measure is answered with nothing',
          STLRender.gridSpacing(null, mm) === null && STLRender.gridSpacing([0, 0, 0], mm) === null &&
          STLRender.gridSpacing([10, 10, 10], 0) === null);

    // Which single plane is worth drawing. It is the face with the most area — the plane across the two
    // larger measures — because that is the one the part would be drawn against.
    check('grid: the plane chosen is the face with the most area',
          STLRender.gridMainPlane([30, 85, 29.6]) === 'back' &&    // 2,550 against 2,516 and 888
          STLRender.gridMainPlane([100, 2, 50]) === 'floor' &&     // a plate: 5,000 against 200 and 100
          STLRender.gridMainPlane([4, 60, 40]) === 'side',         // 2,400 against 240 and 160
          [STLRender.gridMainPlane([30, 85, 29.6]), STLRender.gridMainPlane([100, 2, 50]),
           STLRender.gridMainPlane([4, 60, 40])].join('/'));
    check('grid: a tie goes to the floor, which the model can stand on',
          STLRender.gridMainPlane([10, 10, 10]) === 'floor' && STLRender.gridMainPlane([5, 100, 5]) === 'back',
          STLRender.gridMainPlane([10, 10, 10]) + '/' + STLRender.gridMainPlane([5, 100, 5]));
    check('grid: a model with no area anywhere is given no plane',
          STLRender.gridMainPlane(null) === null && STLRender.gridMainPlane([0, 0, 0]) === null);
    check('grid: the names the view can ask for are the names the renderer draws',
          STLRender.planeNames.join('+') === 'floor+back+side', STLRender.planeNames.join('+'));

    // The pose that suits the planes. The camera looks down -Z and the model turns under it as
    // R = Ry(yaw)·Rx(pitch), so how squarely a plane is met is the z component of its rotated normal —
    // the trig below is spelled out rather than borrowed from three.js, and cross-checked against the
    // vendored build further down.
    const meet = MEET;
    const single = (name) => STLRender.gridView([name]);
    check('grid: one wall on its own is met near head-on, so its squares read as a ruler',
          meet.back(single('back').yaw, single('back').pitch) > 0.93 &&
          meet.side(single('side').yaw, single('side').pitch) > 0.93,
          'back ' + meet.back(single('back').yaw, single('back').pitch).toFixed(3) +
          ', side ' + meet.side(single('side').yaw, single('side').pitch).toFixed(3));
    check('grid: but with a turn left in it, so the part still reads as a solid',
          Math.abs(single('back').yaw) > 0.08 && Math.abs(single('side').yaw + Math.PI / 2) > 0.08 &&
          Math.abs(single('back').pitch) > 0.05,
          JSON.stringify([single('back'), single('side')]));
    check('grid: the floor is read at an angle, not from straight above, or the part on it has no sides',
          meet.floor(single('floor').yaw, single('floor').pitch) > 0.2 &&
          meet.floor(single('floor').yaw, single('floor').pitch) < 0.6 &&
          single('floor').yaw > 0.3,
          meet.floor(single('floor').yaw, single('floor').pitch).toFixed(3));
    check('grid: several planes, or none, want the classic three-quarter view instead',
          STLRender.gridView(['floor', 'back']) === null && STLRender.gridView([]) === null &&
          STLRender.gridView(null) === null && STLRender.gridView(['ceiling']) === null);
}

{
    // A 20 × 10 × 5 mm box standing at z = 10, off the origin so every plane has a real number to sit on.
    const box = boxModel();
    const lo = box.min, hi = box.max;
    const t = boot();
    const ALL3 = ['floor', 'back', 'side'];
    t.viewer.setMesh(box);
    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ALL3 });
    t.viewer.render();
    const drawn = t.viewer.gridInfo();
    const planes = t.sink.lines.slice(0, 3);
    const scene = t.sink.renders.length ? t.sink.renders[0][0] : null;

    check('grid: naming all three draws all three — floor, back wall, side wall',
          !!drawn && drawn.planes.join('+') === 'floor+back+side' && drawn.faces.length === 3 &&
          planes.length === 3,
          JSON.stringify(drawn && drawn.faces));
    check('grid: they belong to the pivot, so they turn with the model rather than staying level under it',
          planes.every((p) => !!p.__parent && p.__parent.rotation.order === 'YXZ' &&
              p.__parent.children.indexOf(p) >= 0 && !!scene && scene.children.indexOf(p) < 0),
          planes.map((p) => p.__parent && p.__parent.rotation.order).join('/'));

    // Half-widths 10, 5 and 2.5, each padded by half a square and snapped up: 40 wide, 20 deep, 20 tall.
    check('grid: each plane reaches at least half a square past the model',
          drawn.across[0] === 40 && drawn.across[1] === 20 && drawn.acrossY === 20, JSON.stringify(drawn));
    check('grid: the floor is made of the 5 + 3 lines that implies',
          drawn.faces[0].lines === 8, JSON.stringify(drawn.faces));
    check('grid: the walls carry the height as well as the width',
          drawn.faces[1].lines === 8 && drawn.faces[2].lines === 6 && drawn.lines === 22,
          JSON.stringify(drawn.faces));
    check('grid: every line of every plane is two vertices in one buffer',
          planes.every((p, i) => p.geometry.attributes.position.array.length === drawn.faces[i].lines * 6),
          planes.map((p) => p.geometry.attributes.position.array.length).join('/'));

    check('grid: the floor lies on the model\'s underside',
          Math.abs(drawn.y + 5.001) < 1e-3, drawn.y);
    check('grid: the walls stand at the model\'s far side and its left, never between the eye and the model',
          Math.abs(drawn.faces[1].fixed - (lo[2] - 12.5)) < 1e-3 &&
          Math.abs(drawn.faces[2].fixed - (lo[0] - 110)) < 1e-3,
          'back z ' + drawn.faces[1].fixed + ', side x ' + drawn.faces[2].fixed);

    // The question the eye asks, in the model's own frame: is the part inside the corner, or has a plane
    // been laid through it?
    let outside = 0;
    for (let i = 0; i < box.positions.length; i += 3) {
        if (box.positions[i] < drawn.faces[2].fixed - 1e-6 ||
            box.positions[i + 1] < drawn.y - 1e-6 ||
            box.positions[i + 2] < drawn.faces[1].fixed - 1e-6) outside += 1;
    }
    check('grid: the model stands inside the corner, with no plane cutting through it',
          outside === 0, outside + ' of ' + (box.positions.length / 3) + ' vertices outside a plane');

    const floorPoints = planes[0].geometry.attributes.position.array;
    const ys = [];
    for (let k = 1; k < floorPoints.length; k += 3) ys.push(floorPoints[k]);
    check('grid: and no line of the floor pokes up past the underside',
          ys.length === drawn.faces[0].lines * 2 && ys.every((v) => Math.abs(v - drawn.y) < 1e-3),
          'floor y ' + drawn.y + ' across ' + ys.length + ' vertices');

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['floor'] });
    check('grid: one plane named means one plane drawn, and only that one',
          t.viewer.gridInfo().faces.length === 1 && t.viewer.gridInfo().faces[0].name === 'floor',
          JSON.stringify(t.viewer.gridInfo().faces));

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['ceiling'] });
    check('grid: a plane nobody named is not an excuse to draw one, or all three',
          t.viewer.gridInfo() === null, JSON.stringify(t.viewer.gridInfo()));

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['side', 'floor'] });
    check('grid: the planes come out in the renderer\'s order however they were asked for',
          t.viewer.gridInfo().planes.join('+') === 'floor+side' &&
          t.viewer.gridInfo().faces.map((f) => f.name).join('+') === 'floor+side',
          JSON.stringify(t.viewer.gridInfo().planes));

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: [] });
    check('grid: naming nothing draws nothing', t.viewer.gridInfo() === null,
          JSON.stringify(t.viewer.gridInfo()));

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ALL3 });

    // Where it lands on the screen, measured with the vendored build's own camera rather than this file's
    // stand-in: the model occupies the pane above the plane, and the plane is what sits at the bottom.
    // A receding floor's far edge reads higher in the frame — that is a floor seen at an angle, not a plane
    // through the middle — so the two questions asked here are not ones perspective can answer.
    const three = (function () {
        const s = { console, setTimeout, clearTimeout, TextDecoder, Math, Date, Number, Array, Object,
                    String, Uint8Array, Uint16Array, Uint32Array, Int32Array, Uint8ClampedArray,
                    Float32Array, Float64Array, ArrayBuffer, DataView, isNaN, isFinite, parseInt,
                    parseFloat, Set, Map, WeakMap, WeakSet, Infinity, NaN, TypeError, Error, RangeError,
                    JSON, Promise, Symbol, Reflect, Proxy, Function, Boolean, RegExp };
        s.globalThis = s; s.window = s;
        const ctx = vm.createContext(s);
        vm.runInContext(fs.readFileSync(path.join(here, '..', 'three.min.js'), 'utf8'), ctx,
                        { filename: 'three.min.js' });
        return ctx.THREE;
    })();
    {
        const camera = new three.PerspectiveCamera(t.STLRender.FOV, 1.5, 0.01, 100);
        camera.position.set(0, 0, 1 / Math.tan((t.STLRender.FOV / 2) * Math.PI / 180) * 1.18);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        const turn = new three.Euler(0.4, 0.62, 0, 'YXZ');            // the default view
        const radius = (function () {
            const g = new three.BufferGeometry();
            g.setAttribute('position', new three.BufferAttribute(Float32Array.from(box.positions), 3));
            g.computeBoundingSphere();
            return g.boundingSphere.radius;
        })();
        const screen = (x, y, z) => new three.Vector3(x, y, z).applyEuler(turn).multiplyScalar(1 / radius)
            .project(camera);
        let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
        for (let i = 0; i < box.positions.length; i += 3) {
            const v = screen(box.positions[i], box.positions[i + 1], box.positions[i + 2]);
            lo = Math.min(lo, v.y); hi = Math.max(hi, v.y); sum += v.y; n += 1;
        }
        const mid = sum / n;
        const floorCentre = screen(0, drawn.y, 0).y;
        const floorLowest = Math.min(screen(-drawn.across[0] / 2, drawn.y, -drawn.across[1] / 2).y,
                                     screen(drawn.across[0] / 2, drawn.y, drawn.across[1] / 2).y);
        // Asked the right way: the floor is the lowest thing in the pane and the model's own middle is
        // above the floor's middle. Whether the plane is under the part is not a screen question at all —
        // it is answered once and for all in the model's own frame, just above, because the camera never
        // moves and the model turns beneath it.
        check('grid: on screen the model stands above its floor, which is the lowest thing drawn',
              floorLowest < lo && floorCentre < mid,
              'model ' + lo.toFixed(2) + ' … ' + hi.toFixed(2) + ' (middle ' + mid.toFixed(2) +
              '), floor ' + floorLowest.toFixed(2) + ' … ' + floorCentre.toFixed(2));
    }

    const before = t.sink.lines.length;
    t.viewer.setGrid(null);
    check('grid: off means no planes and no leftover lines',
          t.viewer.gridInfo() === null && t.sink.lines.length === before, t.viewer.gridInfo());

    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ALL3 });
    t.viewer.setMesh(null);
    check('grid: an empty model takes the planes away with it', t.viewer.gridInfo() === null);

    t.viewer.setMesh(box);
    t.viewer.setGrid({ spacing: 0.0001, color: '#8fa0b5', planes: ALL3 });
    check('grid: planes too fine to read are refused rather than drawn',
          t.viewer.gridInfo() === null, t.viewer.gridInfo());
}

{
    // A gasket: drawn flat in the XY plane, so it has no depth to stand a wall against. Nothing about it
    // is unusual to the person looking at it, so the widest measure carries the missing one and it gets all
    // three planes like anything else.
    const sheet = {
        triangles: 2,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
        center: [60, 35, 0], min: [40, 30, 0], max: [80, 40, 0],
        extents: [40, 10, 0], manifold: true, notes: []
    };
    const t = boot();
    t.viewer.setMesh(sheet);
    t.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['floor', 'back', 'side'] });
    const flat = t.viewer.gridInfo();
    check('grid: a part with no depth still gets all three planes',
          !!flat && flat.faces.length === 3, JSON.stringify(flat));
    check('grid: the widest measure carries the missing one, so they reach past the sheet',
          !!flat && flat.across[0] >= 40 && flat.across[1] >= 40 && flat.acrossY >= 10,
          JSON.stringify(flat));
    check('grid: and the floor sits on the sheet\'s underside, not through it',
          !!flat && flat.y <= -(sheet.max[1] - sheet.center[1]), JSON.stringify(flat));
}

{
    // How strongly each plane is drawn, which depends on its company rather than on which plane it is.
    const flat = {
        triangles: 12,
        positions: new Float32Array(12 * 9).fill(1),
        center: [0, 0, 0], min: [-10, -40, -20], max: [10, 40, 20],
        extents: [20, 80, 40], manifold: true, notes: []
    };
    const alone = boot();
    alone.viewer.setMesh(flat);
    alone.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['back'] });
    check('grid: a wall on its own is drawn as strongly as a floor — it is the only reference there is',
          alone.sink.lines[0].material.opacity === 0.55, alone.sink.lines[0].material.opacity);

    const together = boot();
    together.viewer.setMesh(flat);
    together.viewer.setGrid({ spacing: 10, color: '#8fa0b5', planes: ['floor', 'back', 'side'] });
    check('grid: and it fades back once the floor is there to read the height against',
          together.sink.lines.map((l) => l.material.opacity).join('/') === '0.55/0.3/0.3',
          together.sink.lines.map((l) => l.material.opacity).join('/'));
}

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
