# Python Language Server (pyright)

[pyright](https://github.com/microsoft/pyright), Microsoft's static type checker
and language server for Python, packaged as a MIKE LSP extension. Handles
`.py` and `.pyi` files: completions, hover, diagnostics, go-to-definition,
references, rename, document/workspace symbols, code actions.

Runs in the usual gVisor sandbox over `sandbox-bridge` — `--network none`, with
the project mounted **read-only** at `/mnt/<project>`.

## What works with nothing installed

pyright analyses source statically and ships its own type library inside
`dist/typeshed-fallback`, so a sandbox with no network and no installed
packages still gets:

- full analysis of the project's own modules (cross-file definitions, references,
  rename, diagnostics);
- the Python **standard library** — types, docs, completions;
- **201 third-party packages** from bundled typeshed stubs (`dist/typeshed-fallback/stubs`
  — `requests`, `six`, `paramiko`, `cffi`, `Markdown`, `docutils`, `setuptools`, …).

Note what is deliberately **not** in that list: `numpy`, `pandas`, `flask`, `django`,
`pytest` and friends. typeshed dropped those because they ship inline type
information themselves, so they are only reachable through the mounted
environment — Knob 2.

The gap: a dependency that is neither in the project's own source nor covered by
bundled stubs is reported as unresolvable (`reportMissingImports`) and its
members complete as `Unknown`. That is expected — the sandbox cannot `pip install`
anything. Two knobs below; both are plain files, neither needs MIKE changes.

## Knob 1 — silence unresolved-import diagnostics

Add a `pyrightconfig.json` to the repository root (this is how a Python project
normally configures pyright; it is also read from `[tool.pyright]` in
`pyproject.toml`):

```json
{
  "reportMissingImports": "none",
  "reportMissingModuleSource": "none",
  "reportMissingTypeStubs": "none"
}
```

Verified inside the built image (project mounted read-only at `/mnt/proj`): both
unresolved-import messages disappear while genuine errors are still reported —
`reportOperatorIssue: Operator "+" not supported for types "int" and
"Literal['!']"` survived the change.

`"typeCheckingMode": "off"` also works (measured: the operator error goes away,
hover, completion and go-to-definition keep working) but note it does **not**
silence `reportMissingModuleSource` — that rule is not gated by the mode, so keep
the three lines above alongside it if you want a clean slate.

## Knob 2 — resolve real dependencies offline (optional mount)

Mount the environment the project actually uses, so pyright reads its
`site-packages` instead of guessing. Because extension sandboxes have no
network, the environment must come from the host.

1. **Project → Sandbox Configuration → Mounts**, add:

   | field | value |
   |-------|-------|
   | Host path | `/absolute/path/to/the/project/venv` (the real venv dir) |
   | Container path | `/home/sandbox/<project-name>/.venv` |
   | Mode | `ro` |

   A mount whose container path lives under the task sandbox's project root is
   remapped by the LSP manager onto the LSP workspace, so pyright sees it at
   `<workspace>/.venv`. Saving the mounts recreates the sandbox on next open.

2. Point pyright at it from the repo's `pyrightconfig.json`:

   ```json
   { "venvPath": ".", "venv": ".venv" }
   ```

   (Equivalent, if you prefer an explicit path:
   `{ "extraPaths": [".venv/lib/python3.12/site-packages"] }`.)

Verified inside the built image, with the venv's `bin/python` a **dangling
symlink** and no network: a package that exists **only** inside the mounted venv
resolved for hover (real signature + docstring) and go-to-definition (landing on
`/mnt/proj/.venv/lib/python3.12/site-packages/<pkg>/__init__.py`), and its
`reportMissingImports` error was gone. pyright never executes the interpreter, it
only walks `lib/pythonX.Y/site-packages`, so the venv does not need to be runnable
inside the container, and pure-Python packages work regardless of which machine
created the venv.

## Notes for maintainers

These were measured on pyright 1.1.413 (`dist/pyright-internal.js`), not assumed:

- **No `initParamsOverride` is declared on purpose.** pyright's `initialize`
  reads only `disableLanguageServices` (plus the `service`/`kinds` shape) out of
  `initializationOptions`; analysis settings arrive via `workspace/configuration`
  (a capability MIKE does not advertise, and no MIKE component would answer it)
  or `workspace/didChangeConfiguration` (MIKE never sends it). A session with
  `initializationOptions` carrying `reportMissingImports: "none"` produced
  byte-identical diagnostics to one without it — that config would do nothing
  here. Use Knob 1 instead.
- **No default `sandbox.mounts` entry is declared on purpose.** Every declared
  mount is passed to `podman create`, and an unconfigured empty host path
  resolves to the server's working directory — a placeholder default would bind
  the MIKE repo itself into the sandbox. The mount belongs on the project, where
  the real path is known.
- **No sandbox `envs`.** pyright writes no cache to disk and the container's
  overlay root is writable, so there is nothing to redirect (unlike gopls, whose
  `GOCACHE` must be writable).
- The image installs no Python: pyright analyses source statically and needs no
  interpreter.

## Version pin

The Dockerfile pins `pyright@1.1.413`, the version this extension was verified
against. To upgrade: bump the pin, rebuild the image (Settings → Extensions →
Rebuild), re-run an LSP session, then bump `version` in `manifest.json` and
regenerate the registry.
