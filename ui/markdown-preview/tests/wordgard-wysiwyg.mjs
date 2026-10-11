/**
 * Standalone Playwright diagnostic for this extension: validates that the
 * Wordgard bundle (./lib/wordgard.js) works and that the doc→markdown
 * serializer shared by Preview.js (./serializer.js → window.MarkdownSerializer)
 * round-trips correctly.
 *
 * Run: node tests/wordgard-wysiwyg.mjs
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { frontendWorkspace } from './frontend-workspace.mjs';

// Reuse the Playwright dev dependency from the frontend workspace.
const dir = new URL('.', import.meta.url).pathname;
const require = createRequire(join(frontendWorkspace(dir), 'package.json'));
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.setContent('<!DOCTYPE html><html><body></body></html>');
await page.addScriptTag({ path: dir + '../lib/wordgard.js' });
await page.addScriptTag({ path: dir + '../serializer.js' });

const cases = [
  ['# Hello World', '# Hello World\n'],
  ['Plain paragraph text here.', 'Plain paragraph text here.\n'],
  ['**bold** and *italic* and `code` and [link](https://x.dev).',
   '**bold** and *italic* and `code` and [link](https://x.dev).\n'],
  ['## Sub\n\nSome *emphasized* text.\n\n- one\n- two\n- three',
   '## Sub\n\nSome *emphasized* text.\n\n- one\n- two\n- three\n'],
  ['1. first\n2. second', '1. first\n2. second\n'],
  // A blank line between items is spacing, not a new list: the round-trip
  // emits a tight list, which is the same document.
  ['1. first\n\n2. second\n\n3. third', '1. first\n2. second\n3. third\n'],
  ['- one\n\n- two', '- one\n- two\n'],
  ['1. a\n\n- b', '1. a\n\n- b\n'],
  ['1. a\n2. b\n\na paragraph', '1. a\n2. b\n\na paragraph\n'],
  ['3. third\n4. fourth', '3. third\n4. fourth\n'],
  ['1) first\n2) second', '1. first\n2. second\n'],
  ['1. outer\n   1. inner\n   2. inner2\n2. outer2',
   '1. outer\n\n   1. inner\n   2. inner2\n2. outer2\n'],
  ['- outer\n  - inner\n- outer2', '- outer\n\n  - inner\n- outer2\n'],
  ['1. Run it\n\n   ```bash\n   echo hi\n   ```\n\n2. Done',
   '1. Run it\n\n   ```bash\n   echo hi\n   ```\n2. Done\n'],
  ['> a quoted line\n> another line', '> a quoted line another line\n'], // CommonMark merges soft-wrapped quote lines
  ['```js\nconst x = 1;\n```', '```js\nconst x = 1;\n```\n'],
  ['~~~js\nconst x = 1;\n~~~', '```js\nconst x = 1;\n```\n'],
  ['```js title="a.py"\ncode\n```', '```js\ncode\n```\n'],
  ['````md\n```js\ncode\n```\n````', '````md\n```js\ncode\n```\n````\n'],
  ['---', '---\n'],
  ['![alt](img.png)', '![alt](img.png)\n'],
  ['| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
   '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'],
  ['| **Name** | `code` |\n| - | - |\n| *x* | [y](https://z.dev) |',
   '| **Name** | `code` |\n| --- | --- |\n| *x* | [y](https://z.dev) |\n'],
];

// Mirror Preview.js's Wordgard setup (schema + CodeBlockLanguage + tables + history).
function roundtrip(md) {
  const { Wordgard } = window.WordgardEditor;
  const { fullSchema } = window.WordgardSchema;
  const { history } = window.WordgardHistory;
  const { tables } = window.WordgardTable;
  const { GardState } = window.WordgardState;
  const nt = window.MarkdownSerializer.nt;
  const container = document.createElement('div'); document.body.appendChild(container);
  const ed = Wordgard.create({
    parent: container,
    doc: window.MarkdownSerializer.renderMarkdown(md),
    config: [fullSchema(), GardState.schemaElement.of(nt(window.WordgardTypes.CodeBlockLanguage)), ...tables(), history(), Wordgard.scrolling('100%')],
  });
  const out = window.MarkdownSerializer.docToMarkdown(ed.state.doc);
  if (ed.dom && ed.dom.remove) ed.dom.remove();
  container.remove();
  return out;
}

let pass = 0, fail = 0;
for (const [md, expected] of cases) {
  const got = await page.evaluate(roundtrip, md);
  if (got === expected) { pass++; console.log('PASS', JSON.stringify(md.slice(0, 40))); }
  else { fail++; console.log('FAIL\n  input:   ', JSON.stringify(md), '\n  expected:', JSON.stringify(expected), '\n  got:     ', JSON.stringify(got)); }
}

// Validate parse() returns blocks for code + list (exercises the parse path used on external change).
function parseCountFn(html) {
  const { parse } = window.WordgardDoc;
  const { Wordgard } = window.WordgardEditor;
  const { fullSchema } = window.WordgardSchema;
  const ed = Wordgard.create({ parent: document.createElement('div'), doc: html, config: [fullSchema()] });
  const template = document.createElement('template'); template.innerHTML = html;
  const doc = parse(ed.state.schema, template.content);
  if (ed.dom && ed.dom.remove) ed.dom.remove();
  return doc.content.length;
}
const parseCount = await page.evaluate(parseCountFn, '<p>hi</p><ul><li>a</li></ul><pre><code>x</code></pre>');
console.log('parse block count:', parseCount, '(expected 3)');
if (parseCount === 3) { pass++; console.log('PASS parse'); } else { fail++; console.log('FAIL parse'); }

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
