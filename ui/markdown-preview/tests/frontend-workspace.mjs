/**
 * Locate the MIKE frontend workspace, which carries the dev dependencies these
 * scripts need (playwright, jsdom). Both layouts work: the installed copy
 * inside the app repo (MIKE/extensions/<author>/<name>) and the source repo
 * next to it (MIKE-extensions/ui/<name>). Override with MIKE_FRONTEND.
 */
import { existsSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, sep } from 'node:path';

export function frontendWorkspace(start) {
    if (process.env.MIKE_FRONTEND) return resolve(process.env.MIKE_FRONTEND);
    let d = start;
    for (let i = 0; i < 8; i++) {
        for (const cand of [join(d, 'frontend'), join(d, 'MIKE', 'frontend')]) {
            if (existsSync(join(cand, 'node_modules', 'playwright')) ||
                existsSync(join(cand, 'node_modules', 'jsdom'))) return cand;
        }
        d = resolve(d, '..');
    }
    throw new Error('frontend workspace not found — set MIKE_FRONTEND=/path/to/MIKE/frontend');
}

/**
 * The URL a running server serves this extension's `index.html` from. Only an
 * installed copy has one: the app serves `<extensions>/<author>/<name>/` from
 * the folder layout itself, so that is what this reads. A source checkout has
 * no served path — pass MARKDOWN_PREVIEW_URL to test a copy that lives
 * somewhere else.
 */
export function servedExtensionURL(base, testDir, envVar = 'MARKDOWN_PREVIEW_URL') {
    if (process.env[envVar]) return process.env[envVar];
    const extDir = join(testDir, '..');
    for (let d = dirname(extDir); d !== dirname(d); d = dirname(d)) {
        if (basename(d) === 'extensions' && existsSync(join(dirname(d), 'frontend'))) {
            return `${base}/extensions/${relative(d, extDir).split(sep).join('/')}/index.html`;
        }
    }
    throw new Error(
        'this checkout is not an installed copy, so no server serves it — copy it into '
        + 'the app\'s extensions/<author>/<name>/ and set ' + envVar + ' to that URL');
}
