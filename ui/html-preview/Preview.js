/**
 * HTML Preview — "Preview" footer button for .html/.xhtml/.svg files. Serves
 * the code view's content into a nested sandboxed, opaque-origin iframe.
 *
 * Navigation: the page may move anywhere WITHIN the served tree (the
 * worktree under the token). The extension can't read the frame's URL
 * (opaque origin), so after a load it didn't start it asks the server what
 * was last served under the token: a fresh page from the tree is allowed;
 * anything else stops the preview (token killed, frame reset, user warned).
 */
(() => {
    'use strict';

    const HTML_EXT = /\.(html?|xhtml|svg)$/i;
    const BUTTON_ID = 'html-preview';
    const REFRESH_DEBOUNCE_MS = 300;

    let previewActive = false;
    let currentContent = null; // last content served
    let currentToken = null;   // token of the currently loaded preview doc
    let serveSeq = 0;          // bumps per serve; supersedes in-flight serves
    let refreshTimer = null;
    let allowScripts = false;  // extension setting (config.allow_scripts), read at init
    let allowNetwork = false;  // extension setting (config.allow_network), read at init
    let pendingLoads = 0;      // frame.src sets not yet answered by a load event
    let lastNavSeq = 0;        // last server nav seq we accepted (only grows)
    let navigatedRel = null;   // in-tree page the frame browsed to (null = still on the served doc)
    let decisionPending = false; // a navigation decision is in flight
    let pendingContent = null;   // edit that arrived while a decision was in flight

    const frame = () => document.getElementById('preview-frame');

    // The only place frame().src is written — every set is counted in
    // pendingLoads, and the first load after a set is the doc we installed.
    function setFrameSrc(url) {
        pendingLoads++;
        frame().src = url;
    }

    // Set before the next load. Bare sandbox = no scripts (embedded iframes
    // inherit that); it must match what the serve sent — network implies
    // scripts.
    function applySandboxMode() {
        frame().setAttribute('sandbox', (allowScripts || allowNetwork) ? 'allow-scripts' : '');
    }

    // Stop the preview and kill the doc token so the destination can't keep
    // the doc (and unsaved edits) readable.
    function onNavigationEscape() {
        if (!previewActive) return; // our own src write (closing, or a failed serve)
        setPreviewState(false);
        serveSeq++; // supersede in-flight serves
        releaseCurrent(); // kill the token immediately
        navigatedRel = null;
        pendingContent = null;
        setFrameSrc('about:blank');
        try { extHost.editor.setOverlay(false); } catch (e) {}
        try { setButtonActive(false); } catch (e) {}
        // A modal, not an inline message: the extension iframe collapses to
        // zero height once the overlay is off, so the warning has to stand
        // out over the restored code view.
        extHost.modal({
            title: 'Preview stopped for security',
            message: 'The previewed page tried to navigate away. The preview has been stopped, and its content may have been sent to the destination URL.',
        }).catch(function () {});
    }

    // Returns a rejected promise if the capability is missing (host/extension
    // version skew), so callers can treat it like an escape.
    function navStateFor(token) {
        try {
            return extHost.preview.navState(token);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // Baseline sync after an install load (only ever raise it). Bound to the
    // triggering token: a re-serve in flight must not seed the new token's
    // baseline with the old token's seq.
    function syncNavSeq() {
        const token = currentToken;
        if (!token) return;
        navStateFor(token).then(function (state) {
            if (token === currentToken && state && state.seq > lastNavSeq) lastNavSeq = state.seq;
        }).catch(function () { /* the baseline stays */ });
    }

    function onFrameLoad() {
        if (pendingLoads > 0) {
            pendingLoads--;
            if (previewActive) syncNavSeq();
            return; // the doc we installed
        }
        // A load with nothing pending: the page navigated its own frame
        // (link, location, or <meta refresh>). The frame's URL is unreadable,
        // so the decision comes from the server's nav record.
        const token = currentToken;
        if (!previewActive || !token) {
            onNavigationEscape();
            return;
        }
        decisionPending = true;
        navStateFor(token).then(function (state) {
            decisionPending = false;
            if (token !== currentToken) return; // superseded by a re-serve while in flight
            if (state && state.ok && state.seq > lastNavSeq) {
                // A fresh record: the frame loaded a real file in the tree,
                // so allow it. The server stamps siblings with the doc's CSP,
                // so the egress posture carries over.
                lastNavSeq = state.seq;
                navigatedRel = state.isDoc ? null : state.path;
                // The edit held while this decision was in flight: refresh
                // only if we're back on the doc; on a sibling the code view
                // still holds it.
                const content = pendingContent;
                pendingContent = null;
                if (state.isDoc && content !== null && content !== currentContent) scheduleRefresh(content);
                return;
            }
            onNavigationEscape();
        }).catch(function () {
            decisionPending = false;
            if (token === currentToken) onNavigationEscape(); // doc gone or host error: contain
        });
    }

    function isHtml() {
        const path = (extHost.context && extHost.context.filePath) || '';
        return HTML_EXT.test(path);
    }

    function setButtonActive(active) {
        return extHost.editor.addFooterButton(BUTTON_ID, undefined, active);
    }

    function releaseToken(token) {
        if (token) extHost.preview.release(token).catch(function () {});
    }

    function releaseCurrent() {
        const token = currentToken;
        currentToken = null;
        releaseToken(token);
    }

    // The content goes raw — the server rewrites root-relative refs to the
    // token root (it owns the token). A newer serve supersedes an in-flight
    // one; the superseded doc is released here.
    async function serveAndLoad(content) {
        const seq = ++serveSeq;
        // CSP posture: with scripts off the permissive CSP is safe (a static
        // page can't send anything); with scripts on, strict zero egress
        // unless "allow network" opts into the open network.
        const { token, url } = await extHost.preview.serve(
            content,
            allowScripts,
            !allowScripts || allowNetwork,
        );
        if (seq !== serveSeq) {
            releaseToken(token); // superseded while in flight
            return;
        }
        currentToken = token;
        // Fresh token → the server's nav sequence starts at 0.
        lastNavSeq = 0;
        navigatedRel = null;
        applySandboxMode();
        setFrameSrc(url);
    }

    async function enablePreview() {
        // The preview starts from whatever the code view shows.
        const { content } = await extHost.editor.getContent();
        currentContent = content;
        await serveAndLoad(content);
        await extHost.editor.setOverlay(true);
    }

    async function disablePreview() {
        serveSeq++; // supersede any in-flight serve
        releaseCurrent();
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        setFrameSrc('about:blank');
        await extHost.editor.setOverlay(false);
    }

    function setPreviewState(active) {
        previewActive = active;
        document.body.classList.toggle('preview-off', !active);
    }

    async function togglePreview() {
        setPreviewState(!previewActive);
        try {
            if (previewActive) {
                await enablePreview();
            } else {
                await disablePreview();
            }
            await setButtonActive(previewActive);
        } catch (err) {
            // Serving failed — revert the toggle and surface the error.
            setPreviewState(!previewActive);
            serveSeq++;
            releaseCurrent();
            setFrameSrc('about:blank');
            try { await extHost.editor.setOverlay(!previewActive); } catch (e) {}
            try { await setButtonActive(previewActive); } catch (e) {}
            extHost.error('HTML Preview: ' + (err && err.message ? err.message : err));
        }
    }

    function onFooterClick(data) {
        if (data && data.id === BUTTON_ID) togglePreview();
    }

    // Refresh (debounced), skipped while the frame browses another in-tree
    // page — re-serving would kick the user back to the doc.
    function onContentChange(data) {
        if (!previewActive) return;
        const content = data && typeof data.content === 'string' ? data.content : null;
        if (content === null || content === currentContent) return;
        // A decision is in flight; its outcome decides where the frame ends
        // up. Hold the edit and re-evaluate on resolution — refreshing now
        // would yank the frame back mid-navigation. Must be checked BEFORE
        // navigatedRel: on the way back to the doc, navigatedRel still
        // points at the sibling we came from.
        if (decisionPending) { pendingContent = content; return; }
        if (navigatedRel !== null) return; // browsed to another in-tree page — leave it there
        scheduleRefresh(content);
    }

    function scheduleRefresh(content) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async function () {
            refreshTimer = null;
            if (content === currentContent) return; // already served
            currentContent = content;
            try {
                await serveAndLoad(content);
            } catch (err) {
                extHost.error('HTML Preview: refresh failed: ' + (err && err.message ? err.message : err));
            }
        }, REFRESH_DEBOUNCE_MS);
    }

    // The editor footer may not be ready when we mount (the file loads
    // after), so retry a few times.
    async function addButton(retries = 8) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await extHost.editor.addFooterButton(BUTTON_ID, 'Preview', false);
                return;
            } catch (e) {
                if (attempt === retries) {
                    extHost.log('warn', 'HTML Preview: could not add footer button: ' + (e && e.message));
                    return;
                }
                await new Promise((r) => setTimeout(r, 250));
            }
        }
    }

    extHost.ready().then(function () {
        if (!isHtml()) return;
        allowScripts = !!(extHost.config && extHost.config.allow_scripts);
        allowNetwork = !!(extHost.config && extHost.config.allow_network);
        frame().addEventListener('load', onFrameLoad);
        addButton();
        extHost.on('editor.footerButtonClick', onFooterClick);
        extHost.on('editor.contentChange', onContentChange);
    });
})();
