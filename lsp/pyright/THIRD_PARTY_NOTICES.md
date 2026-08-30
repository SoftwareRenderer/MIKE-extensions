# Third-Party Notices — Python Language Server

This extension's own configuration code (manifest, Dockerfile, docs) is licensed
under Apache-2.0 (see `LICENSE`).

Everything the container runs is fetched at image build time by the pinned
`npm install` in the Dockerfile. Full license texts are available inside each
dependency's package.

| Software | License | Source |
|----------|---------|--------|
| pyright (and the `pyright-langserver` entry point) | MIT | https://github.com/microsoft/pyright (see manifest `license_url`) |
| Node.js runtime (base image `node:22-alpine`) | MIT | https://github.com/nodejs/node |
| typeshed (bundled inside pyright as `dist/typeshed-fallback`) | Apache-2.0 | https://github.com/python/typeshed |
| sandbox-bridge (copied in from the MIKE runtime) | Apache-2.0 | https://getmike.dev |

Dependency licenses are not changed by this extension's license: each library
keeps its own license and copyright.
