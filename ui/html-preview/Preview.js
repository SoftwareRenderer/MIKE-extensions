/**
 * HTML Preview — "Preview" footer button for .html/.xhtml/.svg files. Serves
 * the file content via preview.serve and loads it in the nested
 * sandbox="allow-scripts" iframe (opaque origin: page scripts/assets run;
 * host session/DOM unreachable). Live-refreshes on code-view edits.
 */
(() => {
    'use strict';

    const HTML_EXT = /\.(html?|xhtml|svg)$/i;
    const BUTTON_ID = 'html-preview';
    const REFRESH_DEBOUNCE_MS = 300;

    let previewActive = false;
    let currentContent = null; // last content we served / expect in the editor
    let currentToken = null;   // token of the currently loaded preview doc
    let serveSeq = 0;          // bumps per serve; supersedes in-flight serves
    let refreshTimer = null;

    const frame = () => document.getElementById('preview-frame');

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

    /**
     * The file's directory is the preview's site root (the host's only asset
     * scope), but browsers resolve "/x" against the origin root (the host
     * app). Rewrite root-relative src/href/CSS-url() refs to file-relative;
     * protocol-relative ("//") and absolute ("https:") are untouched.
     */
    function rewriteRootRelative(content) {
        const toRel = function (m, pre, q, slash, rest) {
            if (rest.charAt(0) === '/') return m; // protocol-relative → external
            return pre + q + (rest === '' ? './' : rest) + q;
        };
        return content
            .replace(/(\b(?:href|src|action|poster|content)\s*=\s*)(["'])(\/)([^"']*)\2/g, toRel)
            .replace(/(url\(\s*)(["']?)(\/)([^)"']*?)\2/g, toRel);
    }

    // Serve content into the nested iframe; a newer serve supersedes in-flight
    // ones (the host implicitly releases this editor's previous doc on serve).
    // Close/failure release explicitly for immediate reclaim; a superseded
    // in-flight doc is released here (the host no longer tracks it).
    async function serveAndLoad(content) {
        const seq = ++serveSeq;
        const { token, url } = await extHost.preview.serve(rewriteRootRelative(content));
        if (seq !== serveSeq) {
            releaseToken(token); // superseded while in flight
            return;
        }
        currentToken = token;
        frame().src = url;
    }

    async function enablePreview() {
        const { content } = await extHost.editor.getContent();
        currentContent = content;
        await serveAndLoad(content);
        await extHost.editor.setOverlay(true);
    }

    async function disablePreview() {
        serveSeq++; // any in-flight serve is superseded
        releaseCurrent(); // immediate reclaim on close
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        frame().src = 'about:blank';
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
            releaseCurrent(); // immediate reclaim (close-equivalent)
            frame().src = 'about:blank';
            try { await extHost.editor.setOverlay(!previewActive); } catch (e) {}
            try { await setButtonActive(previewActive); } catch (e) {}
            extHost.error('HTML Preview: ' + (err && err.message ? err.message : err));
        }
    }

    function onFooterClick(data) {
        if (data && data.id === BUTTON_ID) togglePreview();
    }

    function onContentChange(data) {
        if (!previewActive) return;
        if (!data || typeof data.content !== 'string') return;
        if (data.content === currentContent) return; // echo / no change
        currentContent = data.content;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            serveAndLoad(currentContent).catch(function (err) {
                extHost.error('HTML Preview: refresh failed: ' + (err && err.message ? err.message : err));
            });
        }, REFRESH_DEBOUNCE_MS);
    }

    // Retry while the editor footer is still rendering (file loads after mount).
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
        addButton();
        extHost.on('editor.footerButtonClick', onFooterClick);
        extHost.on('editor.contentChange', onContentChange);
    });
})();
