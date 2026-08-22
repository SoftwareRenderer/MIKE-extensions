/**
 * Iframe-level protocol test: mounts the real extension in sandboxed iframes
 * on the dev server and acts as the host over the postMessage protocol.
 * Covers: button registration, click → serve + overlay + load, the three
 * CSP/sandbox combinations (default, scripts-on, scripts+network), the
 * navigation watchdog (decided against a controllable preview.navState
 * record; scenarios 8f/8g cover edits that arrive while a decision is in
 * flight), debounced re-serve, and close → immediate release.
 * Run: node extensions/softwarerenderer/html-preview/tests/html-preview-iframe.mjs
 * (dev server on HTML_PREVIEW_BASE, default https://localhost:3000)
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Reuse the frontend workspace's Playwright dev dependency. The file runs
// from two locations (installed copy under MIKE/extensions/…, source under
// MIKE-extensions/…), so try both relative paths to frontend/package.json.
const dir = new URL('.', import.meta.url).pathname;
const FRONTEND_PKG = [
    resolve(dir, '..', '..', '..', '..', 'frontend', 'package.json'),
    resolve(dir, '..', '..', '..', '..', '..', 'MIKE', 'frontend', 'package.json'),
].find((p) => existsSync(p));
if (!FRONTEND_PKG) throw new Error('cannot locate frontend/package.json relative to ' + dir);
const require = createRequire(FRONTEND_PKG);
const { chromium } = require('playwright');

const BASE = process.env.HTML_PREVIEW_BASE || 'https://localhost:3000';
const HTML = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles.css"></head>' +
             '<body><h1 id="title">hi</h1></body></html>';
// The host sends the RAW editor content unchanged: the root-relative
// rewrite happens on the server (the server owns the token it rewrites into).
const HTML_SERVED = HTML;
const HTML_CHANGED = HTML_SERVED.replace('hi', 'changed');
const HTML_CHANGED_2 = HTML_SERVED.replace('hi', 'changed-2');
const HTML_CHANGED_3 = HTML_SERVED.replace('hi', 'changed-3');
const HTML_CHANGED_4 = HTML_SERVED.replace('hi', 'changed-4');

const ALL_CAPS = ['editor.addFooterButton', 'editor.getContent', 'editor.setOverlay',
    'editor.contentChange', 'preview.serve', 'preview.serveScripts',
    'preview.serveNetwork', 'preview.release', 'preview.navState',
    'ui.status', 'ui.modal', 'log.write'];

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const calls = [];
const serves = [];   // { cap, content }
const releases = [];
const overlays = [];
const buttons = [];  // { frame, id, label, active }
const statuses = []; // ui.status args
const modals = [];   // ui.modal args
let serveCounter = 0;
const navCalls = [];    // navState tokens, in order
const navRecords = {};  // token → controllable nav record (absent = stale/none)
const navDelay = {};    // token → ms to delay the navState response (decision-window tests)

const lastButton = (frame) => {
    for (let i = buttons.length - 1; i >= 0; i--) if (buttons[i].frame === frame) return buttons[i];
    return null;
};

async function waitUntil(fn, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (await fn()) return true;
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
    // Four extension instances with distinct URLs: default settings, a
    // .md file (no button), scripts-only, scripts+network.
    await page.setContent(`
      <div id="host"></div>
      <iframe id="ext-html" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html?ext=html"
        style="width:600px;height:400px;border:none"></iframe>
      <iframe id="ext-md" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html?ext=md"
        style="width:600px;height:400px;border:none"></iframe>
      <iframe id="ext-scr" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html?ext=scr"
        style="width:600px;height:400px;border:none"></iframe>
      <iframe id="ext-net" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html?ext=net"
        style="width:600px;height:400px;border:none"></iframe>
      <iframe id="ext-nav" sandbox="allow-scripts" src="${BASE}/extensions/softwarerenderer/html-preview/index.html?ext=nav"
        style="width:600px;height:400px;border:none"></iframe>
    `);

    await page.exposeFunction('__onCall', (msg, frameId) => {
        calls.push(msg.cap);
        switch (msg.cap) {
            case 'editor.addFooterButton':
                buttons.push({ frame: frameId, id: msg.args.id, label: msg.args.label, active: msg.args.active });
                return {};
            case 'editor.getContent': return { content: HTML };
            case 'editor.setOverlay': overlays.push(!!msg.args.visible); return {};
            case 'preview.serve':
            case 'preview.serveScripts':
            case 'preview.serveNetwork':
                serveCounter++;
                serves.push({ cap: msg.cap, content: msg.args.content });
                return { token: 'harness-token-' + serveCounter, url: `${BASE}/api/preview/harness-token-${serveCounter}/` };
            case 'preview.release': releases.push(msg.args.token); return {};
            case 'preview.navState': {
                const navTok = msg.args.token;
                navCalls.push(navTok);
                // Absent record = stale/none (the watchdog must contain).
                const record = navRecords[navTok] || { seq: 0, path: '', ok: false, isDoc: false };
                const delay = navDelay[navTok] || 0;
                // A delayed response widens the decision window so an edit
                // sent after the call (below) lands while it is in flight.
                return delay
                    ? new Promise((resolve) => setTimeout(() => resolve(record), delay))
                    : record;
            }
            case 'ui.status': statuses.push(msg.args); return {};
            case 'ui.modal': modals.push(msg.args); return {};
            default: return {};
        }
    });
    await page.evaluate(() => {
        window.addEventListener('message', async (ev) => {
            if (!ev.data || ev.data.type !== 'call') return;
            let frameId = '';
            for (const f of document.querySelectorAll('iframe')) {
                if (f.contentWindow === ev.source) frameId = f.id;
            }
            const result = await window.__onCall(ev.data, frameId);
            for (const f of document.querySelectorAll('iframe')) {
                if (f.contentWindow === ev.source) {
                    f.contentWindow.postMessage({ type: 'response', id: ev.data.id, ok: true, data: result }, '*');
                }
            }
        });
    });

    const extFrameOf = (q) => page.frames().find(f => f.url().includes(`?ext=${q}`));
    for (const q of ['html', 'md', 'scr', 'net', 'nav']) {
        if (!extFrameOf(q)) throw new Error('extension iframe ' + q + ' did not load');
    }
    const send = (q, msg) => page.evaluate(([q, m]) => {
        document.getElementById('ext-' + q).contentWindow.postMessage(m, '*');
    }, [q, msg]);
    const init = (q, config, filePath) => send(q, {
        type: 'init',
        extensionId: 'html-preview', extensionName: 'html-preview', point: 'fileEditor',
        granted: ALL_CAPS,
        config,
        context: { component: 'FileEditor', filePath, projectId: 'p1' },
    });

    // 1. init for HTML files → button registered per instance.
    await init('html', {}, 'page.html');
    await init('md', {}, 'README.md');
    await init('scr', { allow_scripts: true }, 'page.html');
    await init('net', { allow_scripts: true, allow_network: true }, 'page.html');
    await init('nav', { allow_scripts: true }, 'page.html');
    check(await waitUntil(() => buttons.length === 4),
        `four HTML instances register a footer button (got ${buttons.length})`);
    check(buttons.every(b => b.id === 'html-preview' && b.label === 'Preview' && b.active === false),
        'buttons id/label are html-preview/Preview, start inactive');
    check(buttons.length === 4 && buttons.filter(b => b.frame === 'ext-md').length === 0,
        'no button for the .md instance');

    // 2. Click the default (scripts OFF) preview → the permissive posture
    // (preview.serveNetwork: a static page is exfil-safe, remote resources
    // render) with the BARE sandbox (no tokens → no scripts, inherited by
    // any iframes the page embeds).
    await send('html', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length > 0 && overlays.includes(true)),
        'default click → preview.serve + editor.setOverlay(true)');
    check(serves.length > 0 && serves[0].cap === 'preview.serveNetwork',
        `scripts-off serve uses preview.serveNetwork (got ${serves[0] && serves[0].cap})`);
    check(serves.length > 0 && serves[0].content === HTML_SERVED,
        `serve received the RAW editor content (server rewrites root-relative refs) (got ${JSON.stringify(serves[0] && serves[0].content)})`);
    const nestedHtml = extFrameOf('html').locator('#preview-frame');
    check((await nestedHtml.getAttribute('src')) === `${BASE}/api/preview/harness-token-1/`,
        'default: nested iframe src is the served url');
    check((await nestedHtml.getAttribute('sandbox')) === '',
        `default: nested iframe has the bare sandbox, scripts off (got ${JSON.stringify(await nestedHtml.getAttribute('sandbox'))})`);
    check(lastButton('ext-html') && lastButton('ext-html').active === true, 'default: button marked active while previewing');

    // 3. editor.contentChange while active → debounced re-serve (same
    // posture), no release call — the host re-serves implicitly.
    await send('html', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED } });
    check(await waitUntil(() => serves.length > 1 && serves[1].content === HTML_CHANGED),
        'contentChange while active → debounced re-serve with new content');
    check(serves.length > 1 && serves[1].cap === 'preview.serveNetwork',
        're-serve keeps the scripts-off posture');

    // 4. Click again → overlay off + frame reset. Closing releases the
    // active doc immediately.
    await send('html', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => overlays.includes(false)), 'second click → editor.setOverlay(false)');
    check(releases.length === 1 && releases[0] === 'harness-token-2',
        `close releases the active token, re-serves never do (got ${JSON.stringify(releases)})`);
    check((await nestedHtml.getAttribute('src')) === 'about:blank', 'default: nested iframe reset to about:blank');
    check(lastButton('ext-html') && lastButton('ext-html').active === false, 'default: button back to inactive after close');

    // 5. Scripts ON (no network) → the strict, zero-egress posture:
    // preview.serveScripts + the allow-scripts token.
    await send('scr', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length > 2 && serves[2].cap === 'preview.serveScripts'),
        `scripts-on serve uses preview.serveScripts (got ${serves[2] && serves[2].cap})`);
    const nestedScr = extFrameOf('scr').locator('#preview-frame');
    check((await nestedScr.getAttribute('sandbox')) === 'allow-scripts',
        'scripts-on: nested iframe is sandbox="allow-scripts"');

    // 6. Scripts + network ON → the permissive posture with scripts.
    await send('net', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length > 3 && serves[3].cap === 'preview.serveNetwork'),
        `network-on serve uses preview.serveNetwork (got ${serves[3] && serves[3].cap})`);
    const nestedNet = extFrameOf('net').locator('#preview-frame');
    check((await nestedNet.getAttribute('sandbox')) === 'allow-scripts',
        'network-on: nested iframe is sandbox="allow-scripts"');

    // 7. Navigation watchdog: an untriggered load on the scripts-on frame
    // simulates the page navigating its own frame (window.location /
    // <meta refresh>). The extension must stop the preview, release the
    // active token, warn the user, and restore the editor — the escaped
    // doc (and its unsaved edits) must not stay readable.
    const overlaysBefore = overlays.length;
    await nestedScr.dispatchEvent('load');
    check(await waitUntil(() => releases.includes('harness-token-3')),
        `watchdog: untriggered load releases the active token (got ${JSON.stringify(releases)})`);
    check(modals.some(m => /navigate away/.test(m.message || '')),
        'watchdog: user warned via ui.modal about the navigation attempt');
    check(!statuses.some(s => s.state === 'error' && /navigate away/.test(s.message || '')),
        'watchdog: the security warning is a modal, not an inline status line');
    check(await waitUntil(async () => (await nestedScr.getAttribute('src')) === 'about:blank'),
        'watchdog: nested iframe reset to about:blank');
    check(await waitUntil(() => overlays.length > overlaysBefore && overlays[overlays.length - 1] === false),
        'watchdog: editor overlay restored');
    check(lastButton('ext-scr') && lastButton('ext-scr').active === false,
        'watchdog: scripts-on button back to inactive');

    // 8. Watchdog ALLOW-LIST (the 'nav' instance). Instead of clicking a
    // link we set frame.src directly to trigger a load — that bypasses the
    // extension's own setter, so the load we trigger is the one we observe.
    // Each drive loads a different committed same-origin sibling under the
    // token: the harness tokens 404 on the real server, but a real HTML 404
    // still fires the frame's load event, while a data: URL would be blocked
    // in flight by the host CSP (frame-src 'self'). We detect the extension's
    // decision by the navState calls it makes (navCalls).
    let driveN = 0;
    const driveLoad = (q, token) => extFrameOf(q).evaluate((u) => {
        document.getElementById('preview-frame').src = u;
    }, `${BASE}/api/preview/${token}/harness-sibling-${++driveN}.html`);
    const navCallsFor = (token) => navCalls.filter(t => t === token).length;
    const waitedForDecision = (token, before) =>
        waitUntil(() => navCallsFor(token) > before, 5000);

    // 8a. Wait for the serve (deterministic token), then for the install
    // load's baseline sync — the harness URL 404s on the real server, but
    // its committed load is what the sync waits for.
    const servesBeforeA = serves.length;
    await send('nav', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length === servesBeforeA + 1 && serves[servesBeforeA].cap === 'preview.serveScripts'),
        'nav: scripts-on serve uses preview.serveScripts');
    const navToken5 = 'harness-token-' + serveCounter;
    check(await waitUntil(() => navCallsFor(navToken5) >= 1),
        'nav: install load synced the baseline nav seq');

    // 8b. Non-ok record (out-of-tree / 404 target) → contained exactly like
    // the legacy watchdog.
    const modalBeforeB = modals.length;
    navRecords[navToken5] = { seq: 1, path: '../outside.html', ok: false, isDoc: false };
    const decBeforeB = navCallsFor(navToken5);
    await driveLoad('nav', navToken5);
    check(await waitedForDecision(navToken5, decBeforeB), 'nav: decision made for the non-ok record');
    check(await waitUntil(() => releases.includes(navToken5)),
        `nav: non-ok record → escape — active token released (got ${JSON.stringify(releases)})`);
    check(modals.length > modalBeforeB && /navigate away/.test(modals[modals.length - 1].message || ''),
        'nav: non-ok record → escape — user warned');
    check(lastButton('ext-nav').active === false, 'nav: non-ok record → button inactive');

    // 8c. Re-enable → fresh token; wait for the serve, then its baseline sync.
    const servesBeforeC = serves.length;
    await send('nav', { type: 'event', cap: 'editor.footerButtonClick', data: { id: 'html-preview' } });
    check(await waitUntil(() => serves.length === servesBeforeC + 1), 'nav: re-enable serves a fresh doc');
    const navToken6 = 'harness-token-' + serveCounter;
    check(await waitUntil(() => navCallsFor(navToken6) >= 1), 'nav: fresh install load synced');

    // 8d. Fresh ok in-tree record → ALLOWED: no release, no modal, preview
    // stays active; contentChange is paused while browsed (no re-serve —
    // re-serving would kick the user back to the doc).
    navRecords[navToken6] = { seq: 1, path: 'page2.html', ok: true, isDoc: false };
    const relBeforeD = releases.length;
    const modalBeforeD = modals.length;
    const decBeforeD = navCallsFor(navToken6);
    await driveLoad('nav', navToken6);
    check(await waitedForDecision(navToken6, decBeforeD), 'nav: decision made for the in-tree record');
    check(releases.length === relBeforeD,
        'nav: in-tree record → allowed — no token release');
    check(modals.length === modalBeforeD,
        'nav: in-tree record → allowed — no warning modal');
    check(lastButton('ext-nav').active === true, 'nav: in-tree record → preview stays active');
    const servesBeforeF = serves.length;
    await send('nav', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED } });
    await new Promise(r => setTimeout(r, 700)); // past the 300ms debounce
    check(serves.length === servesBeforeF,
        `nav: contentChange while browsed does not re-serve (serves ${servesBeforeF} → ${serves.length})`);

    // 8e. A load back on the doc itself (isDoc) restores the refresh flow.
    navRecords[navToken6] = { seq: 2, path: '', ok: true, isDoc: true };
    const decBeforeE = navCallsFor(navToken6);
    await driveLoad('nav', navToken6);
    check(await waitedForDecision(navToken6, decBeforeE), 'nav: decision made for the isDoc record');
    await send('nav', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED } });
    check(await waitUntil(() => serves.length === servesBeforeF + 1 &&
        serves[servesBeforeF].content === HTML_CHANGED),
        'nav: after an isDoc load the refresh flow works again');

    // 8f. Decision-window race: an edit arriving while a decision is in
    // flight (delayed navState makes the window deterministic) must not
    // schedule a yank-back re-serve; on an isDoc decision the held edit
    // refreshes.
    const navToken7 = 'harness-token-' + serveCounter; // 8e's re-serve token
    // The serve check passed at the HOST call — the install load may still
    // be in flight; wait for its sync or the first drive below would be
    // consumed AS the install (no decision would run).
    check(await waitUntil(() => navCallsFor(navToken7) >= 1),
        'nav: 8e re-serve install load synced');
    const servesBeforeG = serves.length;
    navRecords[navToken7] = { seq: 1, path: 'page2.html', ok: true, isDoc: false };
    navDelay[navToken7] = 400;
    const decBeforeF = navCallsFor(navToken7);
    await driveLoad('nav', navToken7);
    check(await waitUntil(() => navCallsFor(navToken7) > decBeforeF, 5000),
        'nav: the unexpected load armed a decision (navState in flight)');
    await send('nav', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED_2 } });
    await new Promise(r => setTimeout(r, 1300)); // delay + debounce margins
    check(serves.length === servesBeforeG,
        `nav: edit during the decision window does not yank back (serves ${servesBeforeG} → ${serves.length})`);

    // No delay: the return-to-doc decision resolves immediately.
    navDelay[navToken7] = 0;
    navRecords[navToken7] = { seq: 2, path: '', ok: true, isDoc: true };
    const decBeforeG2 = navCallsFor(navToken7);
    await driveLoad('nav', navToken7);
    check(await waitUntil(() => navCallsFor(navToken7) > decBeforeG2, 5000),
        'nav: return-to-doc decision made');
    await new Promise(r => setTimeout(r, 200)); // let it resolve

    // A re-load while on the doc arms a decision. An edit in that window is
    // HELD, then refreshes when the isDoc decision resolves.
    const servesBeforeH = serves.length;
    navDelay[navToken7] = 400;
    navRecords[navToken7] = { seq: 3, path: '', ok: true, isDoc: true };
    const decBeforeH = navCallsFor(navToken7);
    await driveLoad('nav', navToken7);
    check(await waitUntil(() => navCallsFor(navToken7) > decBeforeH, 5000),
        'nav: on-doc decision armed (navState in flight)');
    await send('nav', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED_3 } });
    check(await waitUntil(() => serves.length === servesBeforeH + 1 &&
        serves[servesBeforeH].content === HTML_CHANGED_3),
        'nav: an edit held across an on-doc decision refreshes');

    // 8g. The return-to-doc window: an edit made while the return decision
    // is in flight (navigatedRel is still the sibling) is held, then
    // refreshes. The 8f refresh minted a fresh token, so decisions ask for
    // currentToken — wait for that re-serve's install load (its sync).
    const navToken8 = 'harness-token-' + serveCounter;
    check(await waitUntil(() => navCallsFor(navToken8) >= 1, 5000),
        'nav: 8f re-serve install load synced');
    navDelay[navToken8] = 0;
    navRecords[navToken8] = { seq: 1, path: 'page2.html', ok: true, isDoc: false };
    const decBeforeI = navCallsFor(navToken8);
    await driveLoad('nav', navToken8);
    check(await waitUntil(() => navCallsFor(navToken8) > decBeforeI, 5000),
        'nav: sibling nav decision made');
    await new Promise(r => setTimeout(r, 200)); // resolved → back on the sibling

    navDelay[navToken8] = 400;
    navRecords[navToken8] = { seq: 2, path: '', ok: true, isDoc: true };
    const servesBeforeJ = serves.length;
    const decBeforeJ = navCallsFor(navToken8);
    await driveLoad('nav', navToken8);
    check(await waitUntil(() => navCallsFor(navToken8) > decBeforeJ, 5000),
        'nav: return-to-doc decision armed (in flight)');
    await send('nav', { type: 'event', cap: 'editor.contentChange', data: { content: HTML_CHANGED_4 } });
    check(await waitUntil(() => serves.length === servesBeforeJ + 1 &&
        serves[servesBeforeJ].content === HTML_CHANGED_4),
        'nav: an edit held across the return-to-doc window refreshes');
} catch (e) {
    ok = false;
    console.error('iframe test error:', e && e.message ? e.message : e);
    await page.screenshot({ path: '/tmp/html-preview-iframe.png' }).catch(() => {});
} finally {
    console.log('calls received:', calls.join(', ') || '(none)');
    console.log('navState calls:', navCalls.join(', ') || '(none)');
    console.log('page errors:', errors.length ? errors : 'none');
    await browser.close();
}
process.exit(ok ? 0 : 1);
