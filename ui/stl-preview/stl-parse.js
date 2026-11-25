// STL reader: bytes in, triangles out — no dependency, nothing DOM or host, so the same file runs in the
// frame and in the Node tests, parsing in chunks (pump below) so a big file never blocks the frame.
//
// Both .stl forms are read from the shape of the bytes rather than the header word, and every number in them
// is treated as hostile: counts clamped to what the file could hold, non-finite points dropped, and nothing
// read from the file ever sizing an allocation.
(function (global) {
    'use strict';

    var HEAD_BYTES = 84;        // 80-byte header + the uint32 facet count
    var TRIANGLE_BYTES = 50;    // 12 float32 + 2 attribute bytes
    var TRAILING_SLACK = 512;   // exporters that append junk after the last facet
    var CHUNK_FACETS = 50000;   // facets between yields to the event loop
    var MANIFOLD_LIMIT = 50000; // above this, the edge pairing is left unchecked
    var DEFAULT_CAP = 1000000;

    // One scan sees both words: "facet" opens a triangle, "vertex …" fills its corners. Grouping by facet
    // rather than by every third vertex keeps one broken facet from shifting every triangle after it.
    var TOKEN_RE = new RegExp('(\\bfacet\\b[^\\n]*)|(\\bvertex\\b[^\\n]*)', 'gi');
    var NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

    function threeNumbers(line) {
        var out = [], match;
        NUMBER_RE.lastIndex = 0;
        while (out.length < 3 && (match = NUMBER_RE.exec(line)) !== null) {
            var value = parseFloat(match[0]);
            if (!isFinite(value)) return null;
            out.push(value);
        }
        return out.length === 3 ? out : null;
    }

    function isFiniteNumber(x, y, z) {
        return x === x && y === y && z === z &&
            x !== Infinity && x !== -Infinity &&
            y !== Infinity && y !== -Infinity &&
            z !== Infinity && z !== -Infinity;
    }

    function readUint32LE(bytes, offset) {
        return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
                (bytes[offset + 3] << 24)) >>> 0;
    }

    // Text, and shaped like an ASCII STL: the first word is solid or facet and a vertex line appears
    // early — which is what separates it from a binary file whose header happens to read "solid".
    function looksAscii(bytes) {
        var head = bytes.subarray(0, Math.min(bytes.length, 8192));
        var text;
        try {
            text = new TextDecoder('utf-8', { fatal: false }).decode(head);
        } catch (err) {
            return false;
        }
        if (!/^\s*(solid|facet)\b/i.test(text)) return false;
        return /\bvertex\b/i.test(text) && /\b(endloop|outer\s*loop|endsolid)\b/i.test(text);
    }

    function facetsThatFit(bytes) {
        return Math.floor((bytes.length - HEAD_BYTES) / TRIANGLE_BYTES);
    }

    function newBounds() {
        return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    }

    function extendBounds(b, x, y, z) {
        if (x < b.min[0]) b.min[0] = x; else if (x > b.max[0]) b.max[0] = x;
        if (y < b.min[1]) b.min[1] = y; else if (y > b.max[1]) b.max[1] = y;
        if (z < b.min[2]) b.min[2] = z; else if (z > b.max[2]) b.max[2] = z;
    }

    // Runs state.step(state) a chunk at a time until state.done, handing the event loop back in between.
    // A Worker would need a second script and a worker-src the extension cannot see, for a parse that takes a
    // fraction of a second.
    function pump(state, step) {
        return new Promise(function (resolve, reject) {
            function chunk() {
                var n = 0;
                try {
                    while (!state.done && n < CHUNK_FACETS) { step(state); n += 1; }
                } catch (err) { reject(err); return; }
                if (state.done) resolve(state); else setTimeout(chunk, 0);
            }
            chunk();
        });
    }

    // The three points of a facet, written straight into the flat position buffer.
    function writeFacet(state, ax, ay, az, bx, by, bz, cx, cy, cz) {
        var p = state.positions;
        if (state.written === state.capacity) {
            if (state.capacity >= state.maxTriangles) { state.spare += 1; return; }
            var grown = new Float32Array(Math.min(state.maxTriangles, state.capacity * 2) * 9);
            grown.set(p.subarray(0, state.capacity * 9));
            state.positions = p = grown;
            state.capacity = grown.length / 9;
        }
        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        if ((uy * vz - uz * vy) === 0 && (uz * vx - ux * vz) === 0 && (ux * vy - uy * vx) === 0) {
            state.degenerate += 1;
        }
        var base = state.written * 9;
        p[base] = ax; p[base + 1] = ay; p[base + 2] = az;
        p[base + 3] = bx; p[base + 4] = by; p[base + 5] = bz;
        p[base + 6] = cx; p[base + 7] = cy; p[base + 8] = cz;
        extendBounds(state.bounds, ax, ay, az);
        extendBounds(state.bounds, bx, by, bz);
        extendBounds(state.bounds, cx, cy, cz);
        state.written += 1;
    }

    function stepBinary(state) {
        if (state.cursor >= state.count) { state.done = true; return; }
        var off = HEAD_BYTES + state.cursor * TRIANGLE_BYTES;
        var v = state.view;
        var nx = v.getFloat32(off, true), ny = v.getFloat32(off + 4, true), nz = v.getFloat32(off + 8, true);
        var ax = v.getFloat32(off + 12, true), ay = v.getFloat32(off + 16, true), az = v.getFloat32(off + 20, true);
        var bx = v.getFloat32(off + 24, true), by = v.getFloat32(off + 28, true), bz = v.getFloat32(off + 32, true);
        var cx = v.getFloat32(off + 36, true), cy = v.getFloat32(off + 40, true), cz = v.getFloat32(off + 44, true);
        state.cursor += 1;

        if (!isFiniteNumber(ax, ay, az) || !isFiniteNumber(bx, by, bz) || !isFiniteNumber(cx, cy, cz)) {
            state.skipped += 1;
            return;
        }
        if (!isFiniteNumber(nx, ny, nz) || (nx === 0 && ny === 0 && nz === 0)) state.badNormals += 1;
        writeFacet(state, ax, ay, az, bx, by, bz, cx, cy, cz);
    }

    function stepAscii(state) {
        var match = TOKEN_RE.exec(state.text);
        if (match === null) {
            if (state.corner > 0) state.incomplete += 1;      // a tail the file never finished
            state.corner = 0;
            state.done = true;
            return;
        }
        if (match[1] !== undefined) {
            // A new facet opens. Whatever sat half-written belonged to the last one.
            if (state.corner > 0) state.incomplete += 1;
            state.corner = 0;
            state.broken = false;
            return;
        }
        var point = threeNumbers(match[2]);
        if (point === null) {
            // A corner the file did not write as three numbers spoils the whole facet, not the point.
            state.badVertices += 1;
            state.broken = true;
            return;
        }
        var c = state.corner * 3;
        state.pending[c] = point[0]; state.pending[c + 1] = point[1]; state.pending[c + 2] = point[2];
        state.corner += 1;
        if (state.corner < 3) return;

        var p = state.pending;
        state.corner = 0;
        if (state.broken) {
            state.broken = false;
            state.droppedFacets += 1;
            return;
        }
        writeFacet(state, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
    }

    // Every edge shared by exactly two facets → the shell is closed. Vertices are welded on a grid
    // first, because an STL repeats every vertex three times and rarely agrees on the last bits.
    function isManifold(positions, triangles) {
        if (triangles < 1 || triangles > MANIFOLD_LIMIT) return null;
        var total = triangles * 9, i, k, v;
        var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (i = 0; i < total; i += 3) {
            for (k = 0; k < 3; k += 1) {
                v = positions[i + k];
                if (v < lo[k]) lo[k] = v;
                if (v > hi[k]) hi[k] = v;
            }
        }
        var span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        if (!(span > 0)) return false;
        var step = span / 200000;

        var ids = new Map(), edges = new Map(), nextId = 0;
        function vid(x, y, z) {
            var key = Math.round(x / step) + ':' + Math.round(y / step) + ':' + Math.round(z / step);
            var found = ids.get(key);
            if (found === undefined) { found = nextId; ids.set(key, nextId); nextId += 1; }
            return found;
        }
        function edge(a, b) {
            var key = a < b ? a + ':' + b : b + ':' + a;
            edges.set(key, (edges.get(key) || 0) + 1);
        }
        for (i = 0; i < total; i += 9) {
            var a = vid(positions[i], positions[i + 1], positions[i + 2]);
            var b = vid(positions[i + 3], positions[i + 4], positions[i + 5]);
            var c = vid(positions[i + 6], positions[i + 7], positions[i + 8]);
            edge(a, b); edge(b, c); edge(c, a);
        }
        var ok = true;
        edges.forEach(function (n) { if (n !== 2) ok = false; });
        return ok;
    }

    function finish(state, kind, notes) {
        var result = {
            kind: kind,
            notes: notes,
            byteLength: state.byteLength || 0,
            skipped: state.skipped + (state.droppedFacets || 0) + (state.incomplete || 0),
            degenerate: state.degenerate,
            triangles: state.written
        };
        result.positions = state.positions.subarray(0, state.written * 9);
        if (state.spare) {
            // Only an ASCII file gets here: a binary one is read facet by facet up to the cap, so it never
            // asks for a facet the cap would not allow.
            notes.push('capped at ' + group(state.maxTriangles) + ' facets — raise the cap to draw the rest');
        }
        if (state.written > 0 && state.degenerate === state.written) {
            throw new Error('every facet in the file is flat — there is nothing to draw');
        }
        if (state.written > 0) {
            result.min = state.bounds.min;
            result.max = state.bounds.max;
            result.extents = [state.bounds.max[0] - state.bounds.min[0],
                              state.bounds.max[1] - state.bounds.min[1],
                              state.bounds.max[2] - state.bounds.min[2]];
            result.center = [(state.bounds.max[0] + state.bounds.min[0]) / 2,
                             (state.bounds.max[1] + state.bounds.min[1]) / 2,
                             (state.bounds.max[2] + state.bounds.min[2]) / 2];
            result.manifold = isManifold(result.positions, state.written);
        } else {
            result.min = result.max = result.extents = result.center = null;
            result.manifold = null;
        }
        return result;
    }

    // Comma grouping, matching the frame's own numbers so a note written here reads like one written
    // there.
    function group(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function parseBinary(bytes, declared, maxTriangles, notes) {
        var fits = facetsThatFit(bytes);
        var available = declared === null ? fits : Math.min(declared, fits);
        var count = Math.max(0, Math.min(available, maxTriangles));

        if (declared !== null && declared > fits) {
            notes.push('the file claims ' + group(declared) + ' facets but holds room for ' + group(fits));
        }
        if (available > maxTriangles) {
            notes.push('capped at ' + group(maxTriangles) + ' of ' + group(available) + ' facets — raise the cap to draw the rest');
        }

        var state = {
            view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            cursor: 0, count: count, written: 0, capacity: Math.max(count, 1),
            positions: new Float32Array(Math.max(count, 1) * 9),
            bounds: newBounds(), maxTriangles: maxTriangles, spare: 0,
            skipped: 0, degenerate: 0, badNormals: 0, done: false, byteLength: bytes.length
        };
        return pump(state, stepBinary).then(function () {
            if (state.badNormals) {
                notes.push(group(state.badNormals) + ' facets carry no usable normal — the view lights them from the triangle itself');
            }
            return finish(state, 'binary', notes);
        });
    }

    function parseAscii(bytes, maxTriangles, notes) {
        var text;
        try {
            text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch (err) {
            throw new Error('the file is neither a binary STL nor readable text');
        }
        var seed = Math.max(64, Math.min(maxTriangles, Math.floor(text.length / 48)));
        var state = {
            text: text, corner: 0, broken: false, pending: new Float64Array(9),
            written: 0, capacity: seed, positions: new Float32Array(seed * 9),
            bounds: newBounds(), maxTriangles: maxTriangles, spare: 0,
            skipped: 0, badVertices: 0, droppedFacets: 0, incomplete: 0,
            degenerate: 0, done: false, byteLength: bytes.length
        };
        TOKEN_RE.lastIndex = 0;
        return pump(state, stepAscii).then(function () {
            if (state.droppedFacets) {
                notes.push(state.droppedFacets + ' facet(s) dropped for a corner that is not three numbers');
            }
            if (state.incomplete) {
                notes.push(state.incomplete + ' facet(s) had fewer than three corners');
            }
            return finish(state, 'ascii', notes);
        });
    }

    // parse(buffer, { maxTriangles }) → Promise of
    //   { kind, positions: Float32Array(3 per vertex), triangles, min, max, extents, center,
    //     manifold: true|false|null, skipped, degenerate, notes: [string] }
    function parse(buffer, options) {
        var cap = Math.floor(Number(options && options.maxTriangles));
        if (!(cap > 0)) cap = DEFAULT_CAP;

        var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
        var notes = [];
        if (bytes.length === 0) throw new Error('the file is empty');

        if (bytes.length >= HEAD_BYTES) {
            var declared = readUint32LE(bytes, 80);
            var needed = HEAD_BYTES + declared * TRIANGLE_BYTES;
            var fits = facetsThatFit(bytes);

            // The size says binary outright; only when it does not, and the text reads like ASCII STL,
            // is it ASCII. Anything left is a truncated binary file, drawn as far as the bytes reach.
            if (declared > 0 && needed <= bytes.length && bytes.length - needed <= TRAILING_SLACK) {
                return parseBinary(bytes, declared, cap, notes);
            }
            if (looksAscii(bytes)) return parseAscii(bytes, cap, notes);
            if (declared > 0 && declared <= fits) return parseBinary(bytes, declared, cap, notes);
            if (fits >= 1) return parseBinary(bytes, declared > 0 ? declared : null, cap, notes);
            throw new Error('not an STL: ' + bytes.length + ' bytes cannot hold the ' + declared +
                            ' facets its header declares, and it does not read as ASCII');
        }
        if (looksAscii(bytes)) return parseAscii(bytes, cap, notes);
        throw new Error('too small to be an STL file (' + bytes.length + ' bytes)');
    }

    // parse() is the whole surface; looksAscii and isManifold stay internal and are driven through it.
    // The two sizes are exported so a test can build a file to the layout the parser reads.
    var api = {
        parse: parse,
        HEAD_BYTES: HEAD_BYTES,
        TRIANGLE_BYTES: TRIANGLE_BYTES
    };
    global.STLParse = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
