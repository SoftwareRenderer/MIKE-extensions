// The 3D view: one three.js scene per pane, with the camera shared so a diff's two panes turn together, and
// the vendored MIT build beside this file so nothing is fetched.
//
// One geometry serves all three modes — a flat-shaded solid and, over the same buffer, a wireframe mesh —
// because EdgesGeometry rebuilds an edge list on the CPU and takes minutes on a million facets.
(function (global) {
    'use strict';

    var FOV = 45;
    var FIT_MARGIN = 1.18;      // how much of the frame the model fills
    var HALF_FOV_TAN = Math.tan((FOV / 2) * Math.PI / 180);
    var GRID_FIT_CAP = 1.3;     // how much bigger the fit may get to take in a wall

    // The reference planes. A square is one centimetre of whatever unit the caller counts in, because an STL
    // stores bare numbers and says nothing about what they measure.
    var GRID_MAX_LINES = 120;   // lines to one edge before a floor turns into noise
    var GRID_MIN_LINES = 4;     // fewer than this and the grid tells you nothing about size
    var GRID_HARD_CAP = 4000;   // never hand the GPU a floor this fine
    var GRID_CENTOS = [10, 100, 1000, 10000, 100000];   // 10 cm, 1 m, 10 m, 100 m, 1 km

    // The three planes, named for what they are to someone looking at the part. Each is held constant
    // along one axis; `spans` are the two it stretches across, so its area is their product.
    var GRID_PLANES = [
        { name: 'floor', axis: 1, spans: [0, 2] },   // the XZ plane under the model
        { name: 'back',  axis: 2, spans: [0, 1] },   // the XY plane behind it
        { name: 'side',  axis: 0, spans: [2, 1] }    // the YZ plane to its left
    ];
    var GRID_NAMES = GRID_PLANES.map(function (plane) { return plane.name; });

    function create(canvas, THREE, opts) {
        var options = opts || {};
        var mode = options.mode || 'shaded';

        var renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: options.antialias !== false,
            alpha: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance'
        });
        renderer.setClearColor(new THREE.Color(options.background || '#20242b'), 1);

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 100);
        var pivot = new THREE.Group();
        pivot.rotation.order = 'YXZ';
        scene.add(pivot);

        var hemi = new THREE.HemisphereLight(0xffffff, 0x3a4048, 0.85);
        var key = new THREE.DirectionalLight(0xffffff, 0.75);
        key.position.set(0.6, 1.0, 0.8);
        var rim = new THREE.DirectionalLight(0xffffff, 0.35);
        rim.position.set(-0.8, -0.35, -0.6);
        scene.add(hemi, key, rim);

        var geometry = null;
        var fillMaterial = new THREE.MeshLambertMaterial({
            color: new THREE.Color(options.color || '#9fb2c9'),
            flatShading: true,
            side: THREE.DoubleSide      // STL winding is the exporter's business, not ours
        });
        var lineMaterial = new THREE.MeshBasicMaterial({
            color: new THREE.Color(options.lineColor || '#0d1117'),
            wireframe: true,
            transparent: true,
            opacity: 0.3
        });
        var empty = new THREE.BufferGeometry();
        var mesh = new THREE.Mesh(empty, fillMaterial);
        var wire = new THREE.Mesh(empty, lineMaterial);
        mesh.frustumCulled = false;
        wire.frustumCulled = false;
        pivot.add(mesh, wire);

        var footprint = null;         // the model's half-extents and the corner the planes meet at
        var modelRadius = 1;          // the part's own fitted radius, before any plane is drawn
        var fit = 1;                  // the radius the camera has to take in — the part, plus its planes
        var gridSpec = null;          // what setGrid asked for
        var grids = [];               // the planes on screen, one LineSegments each
        var gridState = null;         // what was drawn, for the caller's own test
        // One object, shared by every pane of a diff, so two boxes always look at the same thing from the
        // same place. `panX`/`panY` are fractions of the visible half-height, so a drag moves the part by the
        // same screen distance at any zoom.
        var view = options.view || { yaw: 0.6, pitch: 0.42, zoom: 1, panX: 0, panY: 0 };
        var lost = false;
        canvas.addEventListener('webglcontextlost', function (event) {
            event.preventDefault();
            lost = true;
        }, false);

        function setMesh(parsed) {
            if (geometry) geometry.dispose();
            dropGrid();
            if (!parsed || !parsed.triangles) {
                geometry = null;
                mesh.geometry = wire.geometry = empty;
                footprint = null;
                return;
            }
            // Centre the model on its own middle so the orbit turns about it, then scale it to a unit
            // sphere so one camera distance fits any part, whatever units the file was drawn in.
            var c = parsed.center;
            if (c) {
                var pos = parsed.positions;
                for (var i = 0; i < pos.length; i += 3) {
                    pos[i] -= c[0]; pos[i + 1] -= c[1]; pos[i + 2] -= c[2];
                }
            }
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3));
            geometry.computeBoundingSphere();
            var radius = (geometry.boundingSphere && geometry.boundingSphere.radius) || 1;
            if (!(radius > 0)) radius = 1;
            modelRadius = radius;
            fit = 1;
            mesh.geometry = geometry;
            wire.geometry = geometry;
            pivot.scale.setScalar(1 / radius);
            footprint = measure(parsed);
            buildGrid();
            setMode(mode);
        }

        // The half-extents and the corner of the box the planes meet at: under, behind and to the left of the
        // model. A flat part has no depth to stand a wall against, so the widest measure carries the missing
        // one.
        function measure(parsed) {
            if (!parsed.min || !parsed.max) return null;
            var c = parsed.center || [0, 0, 0];
            var hx = (parsed.max[0] - parsed.min[0]) / 2;
            var hy = (parsed.max[1] - parsed.min[1]) / 2;
            var hz = (parsed.max[2] - parsed.min[2]) / 2;
            if (!(hx > 0) && !(hy > 0) && !(hz > 0)) return null;
            var widest = Math.max(hx, hy, hz);
            if (!(hx > 0)) hx = widest;
            if (!(hy > 0)) hy = widest;
            if (!(hz > 0)) hz = widest;
            var sink = widest * 1e-4;   // a hair outside, so a face flush with a plane cannot fight its lines
            return {
                hx: hx, hy: hy, hz: hz,
                x: parsed.min[0] - c[0] - sink,
                y: parsed.min[1] - c[1] - sink,
                z: parsed.min[2] - c[2] - sink
            };
        }

        // spec: { spacing, color, planes } — `planes` names the planes to draw ('floor', 'back', 'side');
        // any other name, or none, draws nothing.
        function setGrid(spec) {
            var chosen = [];
            if (spec && spec.spacing > 0 && spec.planes) {
                for (var i = 0; i < GRID_PLANES.length; i += 1) {
                    if (spec.planes.indexOf(GRID_PLANES[i].name) >= 0) chosen.push(GRID_PLANES[i].name);
                }
            }
            gridSpec = (spec && spec.spacing > 0 && chosen.length)
                ? { spacing: spec.spacing, color: spec.color, planes: chosen }
                : null;
            buildGrid();
        }

        function dropGrid() {
            fit = 1;
            for (var i = 0; i < grids.length; i += 1) {
                pivot.remove(grids[i]);
                grids[i].geometry.dispose();
                grids[i].material.dispose();
            }
            grids = [];
            gridState = null;
        }

        // One plane: `axis` is the coordinate held constant and `spans` the two it stretches across, each of
        // u and v a [low, high] pair already snapped to whole squares. Every line is two vertices.
        function planeGeometry(face, spacing) {
            var axis = face.axis, axes = face.spans, fixed = face.fixed, u = face.u, v = face.v;
            var nu = Math.round((u[1] - u[0]) / spacing) + 1;
            var nv = Math.round((v[1] - v[0]) / spacing) + 1;
            if (nu < 2 || nv < 2) return null;
            var pos = new Float32Array((nu + nv) * 6);
            var pt = [0, 0, 0];
            var w = 0, i, t;
            pt[axis] = fixed;
            for (i = 0; i < nu; i += 1) {
                t = u[0] + i * spacing;
                pt[axes[0]] = t; pt[axes[1]] = v[0];
                pos[w++] = pt[0]; pos[w++] = pt[1]; pos[w++] = pt[2];
                pt[axes[1]] = v[1];
                pos[w++] = pt[0]; pos[w++] = pt[1]; pos[w++] = pt[2];
            }
            for (i = 0; i < nv; i += 1) {
                t = v[0] + i * spacing;
                pt[axes[1]] = t; pt[axes[0]] = u[0];
                pos[w++] = pt[0]; pos[w++] = pt[1]; pos[w++] = pt[2];
                pt[axes[0]] = u[1];
                pos[w++] = pt[0]; pos[w++] = pt[1]; pos[w++] = pt[2];
            }
            var geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            return { geometry: geometry, lines: nu + nv };
        }

        // The planes meet at the far corner of the model's box, which is not arbitrary: the camera sits at
        // +Z, so a plane behind and to the left can never come between the eye and the model.
        function buildGrid() {
            dropGrid();
            if (!gridSpec || !footprint) return;
            var spacing = gridSpec.spacing;
            var pad = spacing * 0.5;                 // one half square beyond the model on every side
            var ex = Math.ceil((footprint.hx + pad) / spacing) * spacing;
            var ey = Math.ceil((footprint.hy + pad) / spacing) * spacing;
            var ez = Math.ceil((footprint.hz + pad) / spacing) * spacing;
            var high = footprint.y + 2 * ey;

            // A wall fades when the floor is there to read the height against; alone, it is the only
            // reference there is and it keeps the floor's own strength.
            var faint = gridSpec.planes.indexOf('floor') >= 0;
            var wanted = [];
            var i;
            for (i = 0; i < GRID_PLANES.length; i += 1) {
                var plane = GRID_PLANES[i];
                if (gridSpec.planes.indexOf(plane.name) < 0) continue;
                wanted.push({
                    name: plane.name, spans: plane.spans, axis: plane.axis,
                    opacity: plane.name === 'floor' || !faint ? 0.55 : 0.3,
                    fixed: plane.axis === 1 ? footprint.y : (plane.axis === 2 ? footprint.z : footprint.x),
                    u: plane.axis === 0 ? [-ez, ez] : [-ex, ex],
                    v: plane.axis === 1 ? [-ez, ez] : [footprint.y, high]
                });
            }

            var built = [];
            var total = 0;
            for (i = 0; i < wanted.length; i += 1) {
                var face = wanted[i];
                var made = planeGeometry(face, spacing);
                if (!made) continue;
                built.push({ face: face, made: made });
                total += made.lines;
            }
            if (total > GRID_HARD_CAP) return;      // a box this fine is noise, not a reference

            // A plane stands outside the part, so the fit reaches it too — otherwise a wall is sliced off at
            // the pane's edge. Bounded, because two walls are no reason to draw the part itself small.
            var reach = 0;
            for (i = 0; i < built.length; i += 1) {
                var corners = built[i].face;
                var fu = Math.max(Math.abs(corners.u[0]), Math.abs(corners.u[1]));
                var fv = Math.max(Math.abs(corners.v[0]), Math.abs(corners.v[1]));
                reach = Math.max(reach, Math.sqrt(corners.fixed * corners.fixed + fu * fu + fv * fv));
            }
            fit = Math.max(1, Math.min(reach / modelRadius, GRID_FIT_CAP));

            for (i = 0; i < built.length; i += 1) {
                var segment = new THREE.LineSegments(built[i].made.geometry, new THREE.LineBasicMaterial({
                    color: new THREE.Color(gridSpec.color || '#7f8b9c'),
                    transparent: true,
                    opacity: built[i].face.opacity,
                    depthWrite: false
                }));
                segment.frustumCulled = false;
                pivot.add(segment);
                grids.push(segment);
            }
            gridState = {
                spacing: spacing,
                planes: gridSpec.planes,
                lines: total,
                fit: fit,
                faces: built.map(function (b) {
                    return { name: b.face.name, lines: b.made.lines, fixed: b.face.fixed };
                }),
                across: [2 * ex, 2 * ez], acrossY: 2 * ey, y: footprint.y
            };
        }

        function setMode(next) {
            mode = (next === 'edges' || next === 'wireframe') ? next : 'shaded';
            mesh.visible = mode !== 'wireframe';
            wire.visible = mode !== 'shaded';
            lineMaterial.opacity = mode === 'wireframe' ? 0.85 : 0.3;
        }

        function setBackground(color) {
            renderer.setClearColor(new THREE.Color(color || '#20242b'), 1);
        }

        function resize(width, height) {
            var w = Math.max(1, Math.floor(width || canvas.clientWidth || 1));
            var h = Math.max(1, Math.floor(height || canvas.clientHeight || 1));
            renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        }

        // The distance comes from the tighter of the two angular extents — a pane taller than it is wide has
        // less room sideways than above — and zoom only ever dollies. A pan slides the camera along with its
        // own look-at point, so the direction stays exactly -Z and sliding never tilts the model.
        function render() {
            if (lost || !geometry) return;
            pivot.rotation.y = view.yaw;
            pivot.rotation.x = view.pitch;
            var limit = HALF_FOV_TAN * Math.min(1, camera.aspect);
            var distance = FIT_MARGIN * fit / limit / clampZoom(view.zoom);
            var half = distance * HALF_FOV_TAN;
            var x = (view.panX || 0) * half;
            var y = (view.panY || 0) * half;
            camera.position.set(x, y, distance);
            camera.near = Math.max(0.01, distance / 100);
            camera.far = distance * 10;
            camera.lookAt(x, y, 0);
            renderer.render(scene, camera);
        }

        function clampZoom(z) {
            if (!(z > 0)) return 1;      // a caller may hand over anything; this one has to stay a distance
            return Math.min(40, Math.max(0.05, z));
        }

        function dispose() {
            if (geometry) geometry.dispose();
            dropGrid();
            empty.dispose();
            fillMaterial.dispose();
            lineMaterial.dispose();
            pivot.remove(mesh, wire);
            scene.remove(hemi, key, rim);
            renderer.dispose();
        }

        return {
            setMesh: setMesh,
            setMode: setMode,
            setGrid: setGrid,
            setBackground: setBackground,
            resize: resize,
            render: render,
            dispose: dispose,
            isLost: function () { return lost; },
            // What the floor is right now, for the caller's own test: nothing when there is none.
            gridInfo: function () { return gridState; }
        };
    }

    // How many of the file's numbers one centimetre is, and how many lines that needs across the largest
    // measure — the walls are gridded too. 1 cm is tried first, then bigger steps so a large part is not a
    // hatch and one finer step so a tiny part is not two lines; `reason` says when 1 cm was not drawn.
    function gridSpacing(extents, unitsPerCm, maxLines) {
        var cap = Math.floor(Number(maxLines));
        cap = cap > 0 ? Math.min(cap, GRID_HARD_CAP / 2) : GRID_MAX_LINES;
        if (!extents || !(unitsPerCm > 0)) return null;
        var span = Math.max(Math.abs(extents[0]) || 0, Math.abs(extents[1]) || 0, Math.abs(extents[2]) || 0);
        if (!(span > 0)) return null;

        function linesFor(cm) { return Math.ceil(span / (cm * unitsPerCm)) + 1; }

        var cm = 1;
        var reason = '';
        if (linesFor(cm) > cap) {
            reason = 'coarse';
            for (var i = 0; i < GRID_CENTOS.length; i += 1) {
                cm = GRID_CENTOS[i];
                if (linesFor(cm) <= cap) break;
            }
        } else if (linesFor(cm) < GRID_MIN_LINES) {
            reason = 'fine';
            cm = 0.1;
        }
        return { cm: cm, spacing: cm * unitsPerCm, lines: linesFor(cm), at1cm: linesFor(1),
                 reason: reason, span: span };
    }

    // A machine with the driver blacklisted hands back no WebGL context at all. The caller shows a
    // sentence rather than an empty box, so this asks once and answers plainly.
    function available() {
        try {
            var probe = document.createElement('canvas');
            var gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
            var ok = !!gl;
            if (gl && gl.getExtension('WEBGL_lose_context')) gl.getExtension('WEBGL_lose_context').loseContext();
            return ok;
        } catch (err) {
            return false;
        }
    }

    // The plane worth drawing when only one is asked for: the face with the most area. Ties go to the floor,
    // because a part standing on something reads better than one leaning against it.
    function gridMainPlane(extents) {
        if (!extents) return null;
        var best = null;
        var bestArea = 0;
        for (var i = 0; i < GRID_PLANES.length; i += 1) {
            var plane = GRID_PLANES[i];
            var area = Math.abs(Number(extents[plane.spans[0]]) || 0) *
                       Math.abs(Number(extents[plane.spans[1]]) || 0);
            if (area > bestArea) { best = plane.name; bestArea = area; }
        }
        return best;      // null when the model has no area in any direction
    }

    // How a set of planes is met: a single wall nearly head-on — its squares still read as a ruler, with a
    // turn left in it so the part stays a solid — and the three-quarter view for several planes or none.
    var GRID_VIEWS = {
        floor: { yaw: 0.62, pitch: 0.42 },
        back:  { yaw: 0.20, pitch: 0.14 },
        side:  { yaw: -1.37, pitch: 0.14 }
    };

    function gridView(planes) {
        if (!planes || planes.length !== 1) return null;
        var pose = GRID_VIEWS[planes[0]];
        return pose ? { yaw: pose.yaw, pitch: pose.pitch } : null;
    }

    global.STLRender = { create: create, available: available, gridSpacing: gridSpacing,
                         gridMainPlane: gridMainPlane, gridView: gridView,
                         planeNames: GRID_NAMES.slice(), FOV: FOV };
}(typeof globalThis !== 'undefined' ? globalThis : this));
