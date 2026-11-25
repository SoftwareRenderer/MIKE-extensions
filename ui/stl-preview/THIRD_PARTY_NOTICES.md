# Third-Party Notices — STL Preview

This extension's own code (`index.html`, `stl-parse.js`, `stl-render.js`,
`stl-preview.js`, `tests/`, and `manifest.json`) is licensed under Apache-2.0
(see `LICENSE`).

| Software | License | Source |
|----------|---------|--------|
| three.js (revision 149) | MIT | https://github.com/mrdoob/three.js (vendored build at `three.min.js`) |

The extension's `manifest.json` `license_url` describes this extension's own
Apache-2.0 code. three.js is not the extension's license; its own license is
recorded here.

## three.js

STL Preview draws with three.js. The build is vendored beside this file as
`three.min.js` — 608 KB of the r149 distribution, unmodified — so the preview
loads no script and makes no request over the network. A file of that size
cannot be attributed by comment alone, so its license is reproduced below.

`three.min.js` is the minified distribution, and it carries only the short form
of the notice, in the five-line comment at the top of the file:

```
/**
 * @license
 * Copyright 2010-2023 Three.js Authors
 * SPDX-License-Identifier: MIT
 */
```

That header is the same license, abbreviated. The permission notice the MIT
License asks to be kept "in all copies or substantial portions of the Software"
is reproduced in full here, and must be preserved in any distribution.

Source: https://raw.githubusercontent.com/mrdoob/three.js/r149/LICENSE — the
license file of the `r149` tag, which is the revision vendored here.

```
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Note the two forms of the same copyright line: the license file says
`Copyright © 2010-2023 three.js authors` and the minified build's header says
`Copyright 2010-2023 Three.js Authors`. Neither is a correction of the other;
both are reproduced as upstream wrote them.

Dependency licenses are not changed by this extension's license: three.js keeps
its own license and copyright, and this extension's own code stays Apache-2.0.
