/**
 * What a reader sees: the number an ordered list is drawn with and the surface
 * a fenced block is drawn on, measured in a browser from the extension's own
 * stylesheet. The markdown→HTML and doc→markdown tests both pass on a preview
 * that paints `1. … 1. …` and a fence as prose, because neither looks at the
 * document Wordgard renders or at the CSS around it.
 *
 * Run: node tests/render-paint.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { frontendWorkspace } from './frontend-workspace.mjs';

const dir = new URL('.', import.meta.url).pathname;
const require = createRequire(join(frontendWorkspace(dir), 'package.json'));
const { chromium } = require('playwright');

// The subset of the host palette this extension's stylesheet reads. The host
// sends every `--*` property in effect (`theme.get`); a test supplies values.
const HOST_VARS = {
    '--font-sans': 'sans-serif',
    '--font-mono': 'ui-monospace, Menlo, Consolas, monospace',
    '--text-sm': '0.8125rem',
    '--color-surface-0': '#141414',
    '--color-surface-2': '#262626',
    '--color-border': 'rgba(255,255,255,0.1)',
    '--color-accent': '#58a6ff',
    '--color-accent-light': '#79c0ff',
    '--color-accent-bg': 'rgba(56,139,253,0.15)',
    '--color-text-primary': '#e6edf3',
    '--color-text-secondary': '#8b949e',
    '--color-selection-bg': '#1f6feb',
    '--color-bg-page': '#0d1117',
    '--radius-sm': '4px',
    '--radius-md': '6px',
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.setContent('<!DOCTYPE html><html><body><div id="wg-container"></div></body></html>');
// The real stylesheet, out of the page the iframe actually loads.
const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(resolve(dir, '..', 'index.html'), 'utf8'))[1];
await page.addStyleTag({ content: style });
await page.evaluate((vars) => {
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
}, HOST_VARS);
await page.addScriptTag({ path: resolve(dir, '..', 'lib', 'wordgard.js') });
await page.addScriptTag({ path: resolve(dir, '..', 'serializer.js') });

/**
 * Mount the preview the way Preview.js does and report the painted document:
 * each ordered list's start and item text, each fenced block's computed style
 * and how much of it actually scrolls, and the markdown saving this document
 * would write.
 */
function paintInBrowser({ md, width }) {
    const { Wordgard } = window.WordgardEditor;
    const { fullSchema } = window.WordgardSchema;
    const { history } = window.WordgardHistory;
    const { tables } = window.WordgardTable;
    const { GardState } = window.WordgardState;
    const { renderMarkdown, docToMarkdown, nt } = window.MarkdownSerializer;
    const container = document.getElementById('wg-container');
    container.innerHTML = '';
    container.style.width = width ? width + 'px' : '';
    const ed = Wordgard.create({
        parent: container,
        doc: renderMarkdown(md),
        config: [fullSchema(), GardState.schemaElement.of(nt(window.WordgardTypes.CodeBlockLanguage)),
            ...tables(), history(), Wordgard.scrolling('100%')],
    });
    const content = ed.dom.querySelector('wg-content');
    const px = (v) => parseFloat(v) || 0;
    const lists = [...content.querySelectorAll('ol')].map((ol) => ({
        // `start` is what Wordgard writes from its list's number and what the
        // browser enumerates the items from, so it is the drawn first number.
        first: parseInt(ol.getAttribute('start') || '1', 10),
        items: [...ol.querySelectorAll(':scope > li')].map((li) => li.textContent.trim()),
    }));
    const blocks = [...content.querySelectorAll('pre')].map((pre) => {
        const s = getComputedStyle(pre);
        const inner = pre.querySelector('code') ? getComputedStyle(pre.querySelector('code')) : null;
        const scroller = content.closest('wg-scroller') || content;
        return {
            lang: pre.getAttribute('data-language'),
            font: s.fontFamily,
            transparent: s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent',
            padding: px(s.paddingLeft) || px(s.paddingRight) || px(s.paddingTop) || px(s.paddingBottom),
            radius: px(s.borderTopLeftRadius),
            // Whether the block really carries the overflow: what a reader sees
            // is this box scrolling, not the document sliding sideways.
            scrolls: pre.scrollWidth > pre.clientWidth,
            docWidened: scroller.scrollWidth > scroller.clientWidth,
            // Line boxes, counted by where they start: clientHeight would have
            // to give up its padding first, and a nested inline box reports a
            // rect of its own at the same height as its parent's.
            lines: (() => {
                const range = document.createRange();
                range.selectNodeContents(pre);
                return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
            })(),
            innerPadding: inner ? px(inner.paddingLeft) : null,
            innerBackground: inner ? inner.backgroundColor : null,
        };
    });
    const chips = [...content.querySelectorAll('p code, li code')].map((c) => {
        const s = getComputedStyle(c);
        return { transparent: s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent', font: s.fontFamily };
    });
    const saved = docToMarkdown(ed.state.doc);
    ed.dom.remove();
    return { lists, blocks, chips, saved };
}

const paint = (md, width) => page.evaluate(paintInBrowser, { md, width });

let ok = true;
function check(label, cond, detail) {
    if (cond) { console.log(`OK  ${label}`); return; }
    ok = false;
    console.error(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
}
const show = (v) => JSON.stringify(v);

console.log('--- a list interrupted by a paragraph or a fence keeps counting ---');
{
    // The shape README.md is written in: an item, a fence, a blank line, the
    // next item. Every one of these lists starts at its written number.
    const r = await paint('1. Build frontend\n```bash\ncd frontend && npm run build\n```\n\n2. Run backend\n\nprose in between\n\n3. Open the board\n');
    check('it is three lists, drawn 1, 2 and 3',
        r.lists.map((l) => l.first).join() === '1,2,3', show(r.lists));
    check('each holds the item written under it',
        r.lists.map((l) => l.items.join()).join('|') === 'Build frontend|Run backend|Open the board', show(r.lists));
    check('saving keeps the numbers a reader was shown',
        /^1\. Build frontend/m.test(r.saved) && /^2\. Run backend/m.test(r.saved) && /^3\. Open the board/m.test(r.saved),
        show(r.saved));
}
{
    const r = await paint('5. fifth\n');
    check('a list written to start at 5 is drawn from 5', r.lists[0]?.first === 5, show(r.lists));
}

console.log('--- a fenced block is drawn as a code section ---');
{
    const r = await paint('## Setup\n\n```bash\ncd frontend && npm run build\n```\n\nA paragraph for contrast.\n');
    const b = r.blocks[0];
    check('the block is there and keeps its language', r.blocks.length === 1 && b.lang === 'bash', show(r.blocks));
    check('it sits on a surface of its own', b && !b.transparent, show(b));
    check('it is inset from its own edge', b && b.padding > 0, show(b));
    check('it is rounded off as a section', b && b.radius > 0, show(b));
    check('its text is a monospace face', /mono/i.test(b?.font || ''), show(b));
    check('the block itself is not dressed as an inline chip',
        b && (b.innerBackground === 'rgba(0, 0, 0, 0)' || b.innerBackground === 'transparent') && b.innerPadding === 0, show(b));
}
{
    // The long command README.md hands the reader: a fence narrower than its
    // line is the one case where "it renders as code" and "it renders readably"
    // disagree, so which box scrolls is worth a check of its own.
    const md = '```bash\nMIKE_ENCRYPTION_KEY=testkey go run . -listen 0.0.0.0 -allowed-hosts your.hostname.com\n```\n';
    const b = (await paint(md, 360)).blocks[0];
    check('a line wider than the block scrolls inside the block', b && b.scrolls, show(b));
    check('it does not widen the document to do it', b && !b.docWidened, show(b));
    check('and it is still the one line the source wrote', b && b.lines === 1, show(b));
}
{
    const r = await paint('Run `npm test` now.\n');
    check('an inline code span is drawn as a chip',
        r.chips.length === 1 && !r.chips[0].transparent && /mono/i.test(r.chips[0].font), show(r.chips));
}
{
    // A fence belongs to its item, and the item it belongs to is drawn with it.
    const r = await paint('1. Run it\n\n   ```bash\n   echo hi\n   ```\n\n2. Done\n');
    check('a fenced block inside an item is drawn, numbered list intact',
        r.blocks.length === 1 && r.lists.length === 1 && r.lists[0].first === 1 && r.lists[0].items.length === 2,
        show({ blocks: r.blocks.length, lists: r.lists }));
}

console.log(errors.length ? `\npage errors: ${show(errors)}` : '\nno page errors');
console.log(ok && !errors.length ? 'All paint checks passed.' : 'FAILURES — see above.');
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
