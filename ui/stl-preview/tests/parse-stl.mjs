// The parser's own test: pure Node, no browser, no MIKE. stl-parse.js is a plain script that hangs its API off
// globalThis, so it is loaded into a vm context and driven from here — the evidence that can be made without a
// screen, what the parser returns for a file; what the frame draws is the person pressing Try Extension
// (tests/README.md: no node, no browser in the default image).

//   node tests/parse-stl.mjs        exits non-zero on the first failure
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'stl-parse.js'), 'utf8');

const context = vm.createContext({ setTimeout, clearTimeout, TextDecoder, console });
vm.runInContext(source, context, { filename: 'stl-parse.js' });
const STL = context.STLParse;
if (!STL || typeof STL.parse !== 'function') throw new Error('stl-parse.js exposed no STLParse.parse');

// The sizes come from the parser, so a fixture built here is built to the same layout it reads.
const HEAD = STL.HEAD_BYTES;      // 80-byte header + the uint32 facet count
const FACET = STL.TRIANGLE_BYTES; // 12 float32 + 2 attribute bytes

// ------------------------------------------------------------------ fixtures

// A unit tetrahedron: four facets, wound outward, every edge shared by exactly two of them.
const TET = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
];

function normalOf(f) {
    const ux = f[1][0] - f[0][0], uy = f[1][1] - f[0][1], uz = f[1][2] - f[0][2];
    const vx = f[2][0] - f[0][0], vy = f[2][1] - f[0][1], vz = f[2][2] - f[0][2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function binarySTL(facets, header = 'unit tetrahedron') {
    const buffer = new ArrayBuffer(HEAD + facets.length * FACET);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    for (let i = 0; i < header.length && i < HEAD - 4; i += 1) bytes[i] = header.charCodeAt(i);
    view.setUint32(HEAD - 4, facets.length, true);
    facets.forEach((facet, index) => {
        const off = HEAD + index * FACET;
        const n = normalOf(facet);
        [n[0], n[1], n[2], facet[0][0], facet[0][1], facet[0][2],
         facet[1][0], facet[1][1], facet[1][2], facet[2][0], facet[2][1], facet[2][2]]
            .forEach((value, k) => view.setFloat32(off + k * 4, value, true));
        view.setUint16(off + FACET - 2, 0, true);
    });
    return buffer;
}

function asciiSTL(facets, name = 'tet') {
    const lines = ['solid ' + name];
    for (const facet of facets) {
        const n = normalOf(facet);
        lines.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`);
        lines.push('    outer loop');
        for (const v of facet) lines.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`);
        lines.push('    endloop');
        lines.push('  endfacet');
    }
    lines.push('endsolid ' + name);
    return new TextEncoder().encode(lines.join('\n')).buffer;
}

function scattered(count, seed = 7) {
    const facets = [];
    let s = seed;
    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < count; i += 1) {
        facets.push([[rand(), rand(), rand()], [rand(), rand(), rand()], [rand(), rand(), rand()]]);
    }
    return facets;
}

// ------------------------------------------------------------------ the checks

let failed = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log('ok   ' + name);
    } else {
        failed += 1;
        console.log('FAIL ' + (detail === undefined ? '' : '(' + detail + ') ') + name);
    }
}

function near(a, b, epsilon = 1e-4) {
    return a !== null && Math.abs(a - b) <= epsilon;
}

const results = [];

// 1. A binary file reads as binary, with the bounds and the closed shell it describes.
results.push(STL.parse(binarySTL(TET)).then((mesh) => {
    check('binary: kind', mesh.kind === 'binary', mesh.kind);
    check('binary: four facets', mesh.triangles === 4, mesh.triangles);
    check('binary: nine floats per facet', mesh.positions.length === 36, mesh.positions.length);
    check('binary: min at the origin', mesh.min.every((v) => near(v, 0)), JSON.stringify(mesh.min));
    check('binary: max at one', mesh.max.every((v) => near(v, 1)), JSON.stringify(mesh.max));
    check('binary: unit extents', mesh.extents.every((v) => near(v, 1)), JSON.stringify(mesh.extents));
    check('binary: closed shell', mesh.manifold === true, mesh.manifold);
    check('binary: nothing dropped', mesh.skipped === 0 && mesh.degenerate === 0);
}));

// 2. The same shape as text.
results.push(STL.parse(asciiSTL(TET)).then((mesh) => {
    check('ascii: kind', mesh.kind === 'ascii', mesh.kind);
    check('ascii: four facets', mesh.triangles === 4, mesh.triangles);
    check('ascii: closed shell', mesh.manifold === true, mesh.manifold);
    check('ascii: unit extents', mesh.extents.every((v) => near(v, 1)), JSON.stringify(mesh.extents));
}));

// 3. A binary header that reads "solid" is still binary — the trap that makes the first word useless.
results.push(STL.parse(binarySTL(TET, 'solid exported-by-something')).then((mesh) => {
    check('binary header starting with "solid" stays binary', mesh.kind === 'binary', mesh.kind);
}));

// 4. A header declaring more facets than the bytes hold is drawn as far as it reaches.
results.push((async () => {
    const good = new Uint8Array(binarySTL(TET));
    const lying = new Uint8Array(HEAD + 4 * FACET);
    lying.set(good);
    new DataView(lying.buffer).setUint32(HEAD - 4, 40, true);
    const mesh = await STL.parse(lying.buffer);
    check('truncated: drawn to the end of the bytes', mesh.triangles === 4, mesh.triangles);
    check('truncated: says so', mesh.notes.some((n) => /holds room/.test(n)), mesh.notes.join('; '));
})());

// 5. The cap is obeyed and announced.
results.push(STL.parse(binarySTL(scattered(500)), { maxTriangles: 120 }).then((mesh) => {
    check('cap: stops at the cap', mesh.triangles === 120, mesh.triangles);
    check('cap: says so', mesh.notes.some((n) => /capped/.test(n)), mesh.notes.join('; '));
}));

// 5b. The same promise for an ASCII file, which grows its buffer as it goes rather than sizing it up
// front, so the cap is caught at a different place in the parser.
results.push(STL.parse(asciiSTL(scattered(500)), { maxTriangles: 120 }).then((mesh) => {
    check('ascii cap: stops at the cap', mesh.triangles === 120, mesh.triangles);
    check('ascii cap: says so', mesh.notes.some((n) => /capped/.test(n)), mesh.notes.join('; '));
}));

// 6. An open shell is not called closed.
results.push(STL.parse(binarySTL(TET.slice(0, 3))).then((mesh) => {
    check('open shell is reported open', mesh.manifold === false, mesh.manifold);
}));

// 7. Coordinates that are not numbers are dropped with the facet they belong to.
results.push((async () => {
    const broken = ['solid bad', '  facet normal 0 0 -1', '    outer loop',
                    '      vertex 0 0 0', '      vertex NaN 1 0', '      vertex 1 0 0',
                    '    endloop', '  endfacet',
                    '  facet normal 0 -1 0', '    outer loop',
                    '      vertex 0 0 0', '      vertex 1 0 0', '      vertex 0 0 1',
                    '    endloop', '  endfacet', 'endsolid bad'].join('\n');
    const mesh = await STL.parse(new TextEncoder().encode(broken).buffer);
    check('ascii: the sound facet survives', mesh.triangles === 1, mesh.triangles);
    check('ascii: the broken vertex is counted', mesh.skipped === 1, mesh.skipped);
})());

// 8. Junk is refused rather than drawn.
async function refuses(name, bytes) {
    try {
        await STL.parse(bytes);
        check(name, false, 'parsed without complaint');
    } catch (err) {
        check(name, /STL|text|empty|flat|facet/i.test(err.message), err.message);
    }
}
results.push(refuses('empty bytes are refused', new Uint8Array(0).buffer));
results.push(refuses('short junk is refused', new Uint8Array(9).buffer));
results.push(refuses('a big file of nothing is refused', new Uint8Array(5000).buffer));

// 9. Past the chunk size, so the yields between chunks are on the path a real file travels.
results.push((async () => {
    const mesh = await STL.parse(binarySTL(scattered(120000)));
    check('120k facets: all of them', mesh.triangles === 120000, mesh.triangles);
    check('120k facets: shell left unchecked above the limit', mesh.manifold === null, mesh.manifold);
    check('120k facets: bounds are inside the unit box',
          mesh.max.every((v) => v <= 1.0001) && mesh.min.every((v) => v >= -0.0001),
          JSON.stringify([mesh.min, mesh.max]));
})());

// 10. A tessellated sphere: real shared vertices, so the welding the manifold check does has to work
//     on a mesh where each corner is written by many facets rather than by one.
results.push((async () => {
    const rings = 40, segments = 60, facets = [];
    const point = (ring, segment) => {
        const phi = Math.PI * ring / rings, theta = 2 * Math.PI * segment / segments;
        return [Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
    };
    for (let r = 0; r < rings; r += 1) {
        for (let s = 0; s < segments; s += 1) {
            const a = point(r, s), b = point(r + 1, s), c = point(r + 1, (s + 1) % segments), d = point(r, (s + 1) % segments);
            // The two poles are single points, so the quad that touches one is a triangle, not a
            // quad with two corners welded together.
            if (r < rings - 1) facets.push([a, b, c]);
            if (r > 0) facets.push([a, c, d]);
        }
    }
    const mesh = await STL.parse(binarySTL(facets));
    check('sphere: every facet', mesh.triangles === facets.length, mesh.triangles + ' vs ' + facets.length);
    check('sphere: a closed shell at scale', mesh.manifold === true, mesh.manifold);
    check('sphere: no facet is flat', mesh.degenerate === 0, mesh.degenerate);
    check('sphere: unit extents', mesh.extents.every((v) => near(v, 2, 1e-5)), JSON.stringify(mesh.extents));
})());

Promise.all(results).then(() => {
    console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
    process.exit(failed ? 1 : 0);
});
