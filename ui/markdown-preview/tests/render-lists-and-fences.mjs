/**
 * serializer.js — the block structure of lists and fenced code.
 *
 * A list has to survive the shapes people actually write: items split by blank
 * lines, a start number other than 1, a nested list, a fenced block inside an
 * item. A fence has to open on `~~~` and on an info string carrying more than
 * the language, and its content has to stay out of every other block rule.
 *
 * Pure-node test — no dev server, no browser: it loads the real serializer and
 * inspects the HTML it produces.
 * Run: node tests/render-lists-and-fences.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { frontendWorkspace } from './frontend-workspace.mjs';

const dir = new URL('.', import.meta.url).pathname;
const require = createRequire(join(frontendWorkspace(dir), 'package.json'));
const { JSDOM } = require('jsdom');

global.window = new JSDOM('<!doctype html><html><body></body></html>').window;
// The serializer is a plain IIFE that publishes itself on `window`.
eval(readFileSync(resolve(dir, '..', 'serializer.js'), 'utf8'));
const { renderMarkdown, openFence, closeFence } = global.window.MarkdownSerializer;

let ok = true;
function check(label, cond, detail) {
    if (cond) { console.log(`OK  ${label}`); return; }
    ok = false;
    console.error(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
}

/** Render markdown and return { html, root, top } with the parsed result. */
function render(md) {
    const html = renderMarkdown(md);
    const root = new JSDOM(`<div id="r">${html}</div>`).window.document.getElementById('r');
    return { html, root, top: [...root.children].map((el) => el.tagName.toLowerCase()) };
}
const texts = (nodes) => [...nodes].map((n) => n.textContent.trim());

console.log('--- a run of items is one list, blank lines included ---');
{
    const r = render('1. one\n\n2. two\n\n3. three\n');
    check('a loose ordered list stays one <ol>', r.top.join() === 'ol', r.html);
    check('its items keep their order',
        texts(r.root.querySelectorAll('li')).join('|') === 'one|two|three', r.html);
}
{
    const r = render('- one\n\n- two\n');
    check('a loose bullet list stays one <ul>', r.top.join() === 'ul', r.html);
    check('with both items in it', r.root.querySelectorAll('li').length === 2, r.html);
}
{
    const r = render('1. a\n\n- b\n');
    check('a bullet after a numbered item starts a second list', r.top.join() === 'ol,ul', r.html);
}
{
    const r = render('1. a\n2. b\n\nthe list is over\n');
    check('a paragraph at the margin ends the list', r.top.join() === 'ol,p', r.html);
}
{
    const r = render('- a\n\n---\n');
    check('a rule at the margin ends the list', r.top.join() === 'ul,hr', r.html);
}

console.log('--- the number a list starts at is the number it shows ---');
{
    const r = render('3. third\n4. fourth\n');
    check('<ol start> carries the written start',
        r.root.querySelector('ol')?.getAttribute('start') === '3', r.html);
}
{
    const r = render('1. first\n2. second\n');
    check('a list starting at 1 needs no start attribute',
        r.root.querySelector('ol')?.getAttribute('start') === null, r.html);
}
{
    const r = render('1) first\n2) second\n');
    check('a parenthesised enumerator is a list too',
        r.top.join() === 'ol' && r.root.querySelectorAll('li').length === 2, r.html);
}

console.log('--- nested lists and fenced blocks belong to their item ---');
{
    const r = render('1. outer\n   1. inner\n   2. inner2\n2. outer2\n');
    const items = r.root.querySelectorAll(':scope > ol > li');
    check('the nested items are not siblings of the outer ones', items.length === 2, r.html);
    check('the inner list is inside the first item',
        items[0]?.querySelectorAll('ol > li').length === 2, r.html);
}
{
    const r = render('- outer\n  - inner\n- outer2\n');
    check('an indented bullet nests under the one before it',
        r.root.querySelectorAll(':scope > ul > li').length === 2 &&
        r.root.querySelectorAll('ul ul > li').length === 1, r.html);
}
{
    const r = render('- a\n\n  second line of the same item\n\n- b\n');
    check('an indented paragraph stays inside its item',
        r.root.querySelectorAll(':scope > ul > li').length === 2 &&
        r.root.querySelectorAll(':scope > ul > li:first-child > p').length === 2, r.html);
}
{
    const r = render('1. Run it\n\n   ```bash\n   echo hi\n   ```\n\n2. Done\n');
    const pres = r.root.querySelectorAll('pre');
    check('a fenced block inside an item does not split the list',
        r.top.join() === 'ol' && pres.length === 1, r.html);
    check('the fenced block is inside its item',
        pres[0]?.closest('li')?.textContent.includes('Run it') === true, r.html);
    check('the fenced block keeps its language and text',
        pres[0]?.getAttribute('data-language') === 'bash' &&
        pres[0]?.textContent === 'echo hi', r.html);
}

console.log('--- a fence opens on more than a bare ``` line ---');
{
    const r = render('~~~js\nconst x = 1;\n~~~\n');
    check('a ~~~ fence is a code block',
        r.top.join() === 'pre' && r.root.querySelector('pre').getAttribute('data-language') === 'js', r.html);
}
{
    const r = render('```js title="a.py"\ncode\n```\n');
    check('an info string with attributes still opens the fence',
        r.top.join() === 'pre' && r.root.querySelector('pre').getAttribute('data-language') === 'js', r.html);
}
{
    const r = render('~~~\nplain\n~~~\n');
    check('a fence with no info string has no language',
        r.top.join() === 'pre' &&
        r.root.querySelector('pre').getAttribute('data-language') === null, r.html);
}
{
    const r = render('````md\n```js\ncode\n```\n````\n');
    const pre = r.root.querySelector('pre');
    check('a longer fence holds a shorter one',
        r.top.join() === 'pre' && pre.textContent === '```js\ncode\n```', r.html);
}
{
    const r = render('```py\n  keeps\n    indentation\n```\n');
    check('a fence keeps the leading indentation of its lines',
        r.root.querySelector('pre').textContent === '  keeps\n    indentation', r.html);
}

console.log('--- inside a fence nothing else is a block ---');
{
    const r = render('```\n# heading\n- item\n| a | b |\n<b>x</b>\n```\n');
    check('no heading, list, table or markup comes out of a fence',
        r.top.join() === 'pre' && r.root.querySelectorAll('h1,ul,table,b').length === 0, r.html);
    check('the fenced text survives verbatim',
        r.root.textContent.includes('# heading\n- item\n| a | b |\n<b>x</b>'), r.html);
}
{
    const r = render('```js\ncode\neven more code\n');
    check('an unterminated fence runs to the end of the document',
        r.top.join() === 'pre' && r.root.querySelector('pre').textContent.includes('even more code'), r.html);
}
{
    const r = render('```js" onmouseover="boom()\ncode\n```\n');
    const pre = r.root.querySelector('pre');
    check('an info string cannot add an attribute to the <pre>',
        pre.getAttribute('onmouseover') === null && pre.getAttribute('data-language') === 'js', r.html);
}

console.log('--- the fence grammar Preview.js walks source lines with is this one ---');
{
    check('an indented fence opens', openFence('   ```js') !== null);
    check('a ~ fence does not close a ` fence', closeFence('~~~', openFence('```js')) === false);
    check('a shorter fence does not close a longer one', closeFence('```', openFence('````md')) === false);
    check('a longer fence of the same character does', closeFence('`````', openFence('````md')) === true);
    check('a closer carries no info string', closeFence('```js', openFence('```js')) === false);
}

console.log(ok ? '\nAll list/fence structure checks passed.' : '\nFAILURES — see above.');
process.exit(ok ? 0 : 1);
