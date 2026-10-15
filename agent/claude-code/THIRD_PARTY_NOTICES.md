# Third-Party Notices — Claude Code

This extension's own adapter code (`adapter.go`, `types.go`, `helpers.go`, `tools.go`, `wasm/`) is
licensed under Apache-2.0 (see `LICENSE`).

## Claude Code

Claude Code is Anthropic's coding agent. It is **proprietary software**, distributed under
Anthropic's Commercial Terms of Service and its own Acceptable Use Policy
(https://code.claude.com/docs/en/legal-and-compliance).

This extension does not change that, and does not need to:

- It links no Anthropic code and bundles no Anthropic bytes. `claude-code.wasm` is this package's
  own Go code, compiled.
- It redistributes nothing. The `claude` binary is installed by the operator, into the operator's
  own sandbox image, outside this repository.
- It ships no model weights, no API client, and no credential. Authentication is the CLI's own,
  reached through the config directory the operator chose to mount.

Running it is governed by Anthropic's terms and by the plan the operator holds: an installation
that mounts a personal login is using that login's plan from inside a container, and an installation
that supplies `ANTHROPIC_API_KEY` is billing the operator's key. Nothing here decides either.

| Software | License | Source |
|----------|---------|--------|
| Claude Code | Proprietary — Anthropic Commercial Terms of Service | https://claude.com/claude-code (see manifest `license_url`) |
