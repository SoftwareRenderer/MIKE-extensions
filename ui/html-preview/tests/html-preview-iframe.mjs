/**
 * Iframe-level protocol test: mounts the real extension in a sandboxed iframe
 * on the dev server and acts as the host over the postMessage protocol —
 * button registration (.html yes / .md no), click → getContent + serve +
 * overlay + nested iframe load, contentChange → debounced re-serve (no
 * release call — the host re-serves implicitly), second click → overlay off
 * + immediate release of the active doc.
 * Run: node extensions/softwarerenderer/html-preview/tests/html-preview-iframe.mjs
 * (dev server on HTML_PREVIEW_BASE, default https://localhost:3000)
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Reuse the Playwright dev dependency from the frontend workspace.
const dir = new URL('.', import.meta.url).pathname;
const require = createRequire(resolve(dir, '..', '..', '..', '..', 'frontend', 'package.json'));
const { chromium } = require('playwright');

const BASE = process.env.HTML_PREVIEW_BASE || 'https://localhost:3000';
const HTML = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles.css"></head>' +
             '<body><h1 id="title">hi</h1></body></html>';
// Root-relative refs are rewritten to file-relative before serve.
const HTML_SERVED = HTML.replace('href="/styles.css"', 'href="styles.css"');

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const calls = [];
const serves = [];
const releases = [];
const overlays = [];
const buttons = [];
let serveCounter = 0;

async function waitUntil(fn, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

let ok = true;
function check(cond, label) {
    if (cond) console.log('OK  ' + label);
    else { ok = false; console.error('FAIL ' + label); }
}

try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.setContent(`
      <div id="host"></div>
      <iframe id="ext-html" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html"
        style="width:600px;height:400px;border:none"></iframe>
      <iframe id="ext-md" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html"
        style="width:600px;height:400px;border:none"></iframe>
    `);

    await page.exposeFunction('__onCall', (msg) => {
        calls.push(msg.cap);
        switch (msg.cap) {
            case 'editor.addFooterButton':
                buttons.push({ id: msg.args.id, label: msg.args.label, active: msg.args.active });
                return {};
            case 'editor.getContent': return { content: HTML };
            case 'editor.setOverlay': overlays.push(!!msg.args.visible); return {};
            case 'preview.serve':
                serves.push(msg.args.content);
                serveCounter++;
                return { token: 'harness-token-' + serveCounter, url: `${BASE}/api/preview/harness-token-${serveCounter}/` };
            case 'preview.release': releases.push(msg.args.token); return {};
            default: return {};
        }
    });
    await page.evaluate(() => {
        window.addEventListener('message', async (ev) => {
            if (!ev.data || ev.data.type !== 'call') return;
            const result = await window.__onCall(ev.data);
            for (const f of document.querySelectorAll('iframe')) {
                if (f.contentWindow === ev.source) {
                    f.contentWindow.postMessage({ type: 'response', id: ev.data.id, ok: true, data: result }, '*');
                }
            }
        });
    });

    const extFrame = page.frames().find(f => f.url().includes('html-preview'));
    if (!extFrame) throw new Error('extension iframe did not load');
    const send = (frameId, msg) => page.evaluate(([id, m]) => {
        document.getElementById(id).contentWindow.postMessage(m, '*');
    }, [frameId, msg]);

    // 1. init for an HTML file → Preview button gets registered.
    await send('ext-html', {
        type: 'init',
        extensionId: 'html-preview', extensionName: 'html-preview', point: 'fileEditor',
        granted: ['editor.addFooterButton', 'editor.getContent', 'editor.setOverlay',
                  'editor.contentChange', 'preview.serve', 'preview.release', 'log.write'],
        config: {},
        context: { component: 'FileEditor', filePath: 'page.html', projectId: 'p1' },
    });
    check(await waitUntil(() => buttons.length > 0), 'extension registered a footer button for .html');
    check(buttons.length > 0 && buttons[0].id === 'html-preview' && buttons[0].label === 'Preview',
        `button id/label are html-preview/Preview (got ${JSON.stringify(buttons[0] || null)})`);
    check(buttons.length > 0 && buttons[0].active === false, 'button starts inactive');

    // 2. init for a Markdown file → no button.
    await send('ext-md', {
        type: 'init',
        extensionId: 'html-preview', extensionName: 'html-preview', point: 'fileEditor',
        granted: ['editor.addFooterButton', 'editor.getContent', 'editor.setOverlay',
                  'editor.contentChange', 'preview.serve', 'preview.release', 'log.write'],
        config: {},
        context: { component: 'FileEditor', filePath: 'README.md', projectId: 'p1' },
    });
    await new Promise(r => setTimeout(r, 400));
    check(buttons.length === 1, 'no button for .md files');

    // 3. Click Preview → content fetched, served, overlay on, nested iframe loaded.
    await send('ext-html', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length > 0 && overlays.includes(true)),
        'click → preview.serve + editor.setOverlay(true)');
    check(serves.length > 0 && serves[0] === HTML_SERVED,
        `preview.serve received the editor content with root-relative refs rewritten (got ${JSON.stringify(serves[0] || null)})`);
    const nested = extFrame.locator('#preview-frame');
    const src = await nested.getAttribute('src');
    check(src === `${BASE}/api/preview/harness-token-1/`, `nested iframe src is the served url (got ${src})`);
    const sandbox = await nested.getAttribute('sandbox');
    check(sandbox === 'allow-scripts', `nested iframe is sandbox="allow-scripts" (got ${sandbox})`);
    check(await waitUntil(() => buttons.some(b => b.id === 'html-preview' && b.active)),
        'button marked active while previewing');

    // 4. editor.contentChange while active → debounced new serve.
    const changed = HTML_SERVED.replace('hi', 'changed');
    await send('ext-html', { type: 'event', cap: 'editor.contentChange', data: { content: changed } });
    check(await waitUntil(() => serves.length > 1 && serves[1] === changed),
        'contentChange while active → debounced re-serve with new content');

    // 5. Click Preview again → overlay off + frame reset. Closing releases the
    // active doc immediately; re-serves (contentChange) never do — the host
    // handles those implicitly.
    await send('ext-html', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => overlays.includes(false)), 'second click → editor.setOverlay(false)');
    check(releases.length === 1 && releases[0] === 'harness-token-2',
        `close releases the active token, re-serves never do (got ${JSON.stringify(releases)})`);
    const srcOff = await nested.getAttribute('src');
    check(srcOff === 'about:blank', `nested iframe reset to about:blank (got ${srcOff})`);
    check(await waitUntil(() => {
        const last = buttons[buttons.length - 1];
        return last && last.id === 'html-preview' && last.active === false;
    }), 'button back to inactive');
} catch (e) {
    ok = false;
    console.error('iframe test error:', e && e.message ? e.message : e);
    await page.screenshot({ path: '/tmp/html-preview-iframe.png' }).catch(() => {});
} finally {
    console.log('calls received:', calls.join(', ') || '(none)');
    console.log('page errors:', errors.length ? errors : 'none');
    await browser.close();
}
process.exit(ok ? 0 : 1);
