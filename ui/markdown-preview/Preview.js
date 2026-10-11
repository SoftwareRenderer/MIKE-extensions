/**
 * Markdown Preview — a "Preview" button in the editor footer for Markdown
 * files, toggling between the code view and a Wordgard WYSIWYG view.
 */
(() => {
    'use strict';

    const MARKDOWN_EXT = /\.(md|markdown|mdown|mkdn|mkd)$/i;
    const BUTTON_ID = 'markdown-preview';

    // Shared serializer/renderer (./serializer.js, loaded before this file).
    const { renderMarkdown, docToMarkdown, openFence, closeFence, nt } = window.MarkdownSerializer || {};
    const T = () => window.WordgardTypes;

    let previewActive = false;
    let wgEditor = null;
    const ECHO_WINDOW_MS = 5000;  // how long a pushed document still counts as our own echo
    const ECHO_MAX = 16;
    let recentPushes = [];

    function rememberPush(md) {
        const now = Date.now();
        recentPushes.push([md, now]);
        while (recentPushes.length > ECHO_MAX ||
            (recentPushes.length && now - recentPushes[0][1] > ECHO_WINDOW_MS)) {
            recentPushes.shift();
        }
    }

    /** True if `content` is (a recent) echo of one of our own pushes. */
    function isOwnEcho(content) {
        const now = Date.now();
        return recentPushes.some(([md, at]) => md === content && now - at <= ECHO_WINDOW_MS);
    }

    /** Apply the host's current palette to this iframe's :root. */
    function applyTheme(variables) {
        if (!variables) return;
        const root = document.documentElement;
        for (const key of Object.keys(variables)) {
            if (key.startsWith('--')) root.style.setProperty(key, variables[key]);
        }
    }

    function isMarkdown() {
        const path = (extHost.context && extHost.context.filePath) || '';
        return MARKDOWN_EXT.test(path);
    }

    function setButtonActive(active) {
        // Passing no label keeps the button's existing "Preview" label.
        return extHost.editor.addFooterButton(BUTTON_ID, undefined, active);
    }

    // Move strikethrough out of the "More" submenu and drop that submenu, whose
    // other toolbar items have no Markdown representation (see index.html).
    function reorganizeMenu(container) {
        const menubar = container.querySelector('wg-menubar');
        if (!menubar) return false;
        const more = menubar.querySelector('wg-submenu[title="More"]');
        if (!more) return false; // toolbar not mounted yet
        const strike = more.querySelector('button[title="Toggle strikethrough"]');
        if (strike) more.parentNode.insertBefore(strike, more);
        more.remove();
        return true;
    }

    // The toolbar mounts after Wordgard.create returns, so wait for it and stop
    // observing once it has been reorganized.
    function observeMenuReorg(container) {
        const mo = new MutationObserver(() => {
            if (reorganizeMenu(container)) mo.disconnect();
        });
        mo.observe(container, { childList: true, subtree: true });
        if (reorganizeMenu(container)) mo.disconnect();
    }

    // ── WYSIWYG editor lifecycle ─────────────────────────────────────────

    function onWysiwygKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            e.stopPropagation();
            if (!wgEditor) return;
            // Push the edited text to the code view before saving the file.
            const md = docToMarkdown(wgEditor.state.doc);
            extHost.editor.setContent(md)
                .then(function () { return extHost.editor.save(); })
                .catch(function () {});
        }
    }

    function destroyWysiwyg() {
        if (wgEditor) {
            // Wordgard has no destroy(): removing the editor element releases it.
            try { if (wgEditor.dom && wgEditor.dom.remove) wgEditor.dom.remove(); } catch (e) {}
            wgEditor = null;
        }
        const c = document.getElementById('wg-container');
        if (c) c.remove();
        recentPushes = [];
    }

    function createWysiwyg(markdown) {
        destroyWysiwyg();
        const needed = ['WordgardEditor', 'WordgardSchema', 'WordgardHistory',
            'WordgardTable', 'WordgardState', 'WordgardTypes'];
        const missing = needed.filter((name) => !window[name]);
        if (missing.length) {
            extHost.error('Markdown Preview: Wordgard bundle failed to load (missing ' + missing.join(', ') + ')');
            return;
        }
        const { Wordgard, menuBar } = window.WordgardEditor;
        const { fullSchema } = window.WordgardSchema;
        const { history } = window.WordgardHistory;
        const { tables } = window.WordgardTable;
        const { GardState } = window.WordgardState;
        const t = T();

        const container = document.createElement('div');
        container.id = 'wg-container';
        document.body.appendChild(container);
        container.addEventListener('keydown', onWysiwygKeyDown);

        wgEditor = Wordgard.create({
            parent: container,
            doc: renderMarkdown(markdown),
            config: [
                fullSchema(),
                // Without the CodeBlockLanguage mark, the language of a fenced
                // block would not survive the WYSIWYG round-trip.
                GardState.schemaElement.of(nt(t.CodeBlockLanguage)),
                ...tables(),
                history(),
                // The formatting toolbar; menuBar() returns an extension array.
                ...menuBar(),
                Wordgard.scrolling('100%'),
                Wordgard.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    const md = docToMarkdown(update.state.doc);
                    rememberPush(md);
                    extHost.editor.setContent(md).catch(() => {});
                }),
            ],
        });
        observeMenuReorg(container);
    }

    /** Index of the heading opened by markdown source line `line` (1-based), or
     * -1 when that line is not a heading. */
    function headingIndexForLine(markdown, line) {
        const lines = String(markdown || '').split('\n');
        let index = -1;
        // Count with the renderer's fence grammar: a "#" inside a fence is a
        // comment, and the host's outline counts the same lines.
        let fence = null;
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].trim();
            if (fence) {
                if (closeFence(text, fence)) fence = null;
                continue;
            }
            const open = openFence(text);
            if (open) { fence = open; continue; }
            if (/^(#{1,6})\s+/.test(text)) {
                index++;
                if (i + 1 === line) return index;
            }
        }
        return -1;
    }

    /** Scroll to the heading at markdown source `line`, as asked by the host's
     * symbol outline. A no-op while the preview is off. */
    function scrollToSourceLine(line) {
        if (!previewActive || !wgEditor || !window.WordgardEditor) return;
        const { Wordgard } = window.WordgardEditor;
        extHost.editor.getContent().then(function (res) {
            if (!previewActive || !wgEditor) return; // toggled off meanwhile
            const index = headingIndexForLine(res && res.content, line);
            if (index < 0) return; // not a heading line
            const doc = wgEditor.state.doc;
            const t = T();
            let pos = -1;
            let count = 0;
            doc.iterate(0, doc.length, function (node, nodePos) {
                if (node.type === nt(t.Heading)) {
                    if (count === index) pos = nodePos;
                    count++;
                }
            });
            if (pos < 0) return;
            // Put the heading near the top of the viewport, like the code view
            // jump does, rather than just inside it.
            wgEditor.dispatch({ effects: [Wordgard.scrollIntoView(pos, { y: 'start', yMargin: 8 })] });
        }).catch(function () {});
    }

    /** Replace the Wordgard document from new markdown (external change). */
    function replaceDocFromMarkdown(markdown) {
        if (!wgEditor || !window.WordgardDoc) return;
        const { parse } = window.WordgardDoc;
        const template = document.createElement('template');
        template.innerHTML = renderMarkdown(markdown);
        let doc;
        try {
            doc = parse(wgEditor.state.schema, template.content);
        } catch (e) {
            extHost.log('warn', 'Markdown Preview: parse failed: ' + (e && e.message));
            return;
        }
        // Keep the caret at the same text offset, clamped into the new document;
        // without a selection it lands at the top of the document.
        const sel = wgEditor.state.selection;
        const clamp = (p) => Math.max(0, Math.min(p, doc.length));
        wgEditor.dispatch({
            changes: { from: 0, to: wgEditor.state.doc.length, insert: doc.content },
            selection: { anchor: clamp(sel.anchor), head: clamp(sel.head) },
        });
    }

    async function togglePreview() {
        previewActive = !previewActive;
        document.body.classList.toggle('preview-off', !previewActive);
        try {
            if (previewActive) {
                const { content } = await extHost.editor.getContent();
                createWysiwyg(content);
                await extHost.editor.setOverlay(true);
            } else {
                destroyWysiwyg();
                await extHost.editor.setOverlay(false);
            }
            await setButtonActive(previewActive);
        } catch (err) {
            extHost.error('Preview failed: ' + (err && err.message ? err.message : err));
        }
    }

    function onFooterClick(data) {
        if (data && data.id === BUTTON_ID) togglePreview();
    }

    function onContentChange(data) {
        if (!previewActive || !wgEditor) return;
        if (!data || typeof data.content !== 'string') return;
        // Ignore echoes of our own pushes, however late they arrive: only text
        // we never pushed is an external change.
        if (isOwnEcho(data.content)) return;
        replaceDocFromMarkdown(data.content);
    }

    // Retry while the editor footer is still being rendered.
    async function addButton(retries = 8) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await extHost.editor.addFooterButton(BUTTON_ID, 'Preview', false);
                return;
            } catch (e) {
                if (attempt === retries) {
                    extHost.log('warn', 'Markdown Preview: could not add footer button: ' + (e && e.message));
                    return;
                }
                await new Promise((r) => setTimeout(r, 250));
            }
        }
    }

    extHost.ready().then(function () {
        if (!isMarkdown()) return;
        extHost.theme.get()
            .then(function (res) { applyTheme(res && res.variables); })
            .catch(function () {});
        extHost.on('theme.update', function (data) {
            if (data && data.variables) applyTheme(data.variables);
        });
        addButton();
        extHost.on('editor.footerButtonClick', onFooterClick);
        extHost.on('editor.contentChange', onContentChange);
        extHost.on('editor.jumpToLine', function (data) {
            if (data && typeof data.line === 'number') scrollToSourceLine(data.line);
        });
    });
})();
