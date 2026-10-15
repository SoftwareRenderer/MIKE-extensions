# Claude Code Agent Extension

This extension integrates [Claude Code](https://claude.com/claude-code) as an agent extension for
[MIKE](https://getmike.dev). When a task is configured with `llama_server_url: "agent://claude-code"`,
MIKE spawns the `claude` binary and manages its lifecycle through a WASM adapter.

Claude Code is Anthropic's product. This extension packages it and speaks its documented transport;
it is not affiliated with, endorsed by, or sponsored by Anthropic, and it ships no Anthropic code —
see `THIRD_PARTY_NOTICES.md`.

## Overview

Claude Code is a full coding agent: it makes its own LLM calls, runs its own tools, and does its own
reasoning. MIKE provides the sandbox, owns the subprocess, and streams the result to the board. Every
protocol decision lives in the WASM adapter.

```
MIKE (Go server)
    │  JSON config
    ▼
WASM Adapter (claude-code.wasm)
    │  JSONL commands / JSONL messages
    ▼
Claude Code process (binary on $PATH, one per task run)
    │  LLM API calls, tool execution
    ▼
Anthropic API
```

## Architecture

```
MIKE Backend (Go) ── AgentAdapter ──► AgentRunner ── wazero ──► claude-code.wasm ── stdio ──► claude
```

| Piece | Where |
|---|---|
| Event and command contract | MIKE `pkg/agent/types.go` |
| Subprocess, stdin/stdout bridge, event dispatch | MIKE `backend/agent/runner.go` |
| WASM host (alloc, `store_result`) | MIKE `backend/agent/loader.go` |
| WASI reactor exports | `wasm/main.go` |
| Protocol logic | `adapter.go`, `types.go`, `tools.go`, `helpers.go` |

### Transport

`claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --permission-mode dontAsk --allowedTools <list>`

The flags and the message shapes are the CLI's documented headless interface
([Headless mode](https://code.claude.com/docs/en/headless),
[permission modes](https://code.claude.com/docs/en/permission-modes),
[cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).

One JSON object per line in both directions. The process is **kept across a task run's turns**: a
message written to stdin continues the same conversation, which is the only continuity the CLI offers
a harness that cannot restart it.

| Out (MIKE → CLI) | In (CLI → MIKE) |
|---|---|
| `{"type":"user","message":{…}}` | `system` / `init`, `compact_boundary`, `api_retry`, `permission_denied` |
| `{"type":"control_request","request":{"subtype":"initialize"}}` | `stream_event` (deltas) |
| `{"type":"control_request","request":{"subtype":"set_model",…}}` | `assistant`, `user` (assembled messages) |
| `{"type":"control_request","request":{"subtype":"interrupt"}}` | `result` (ends the turn) |
| | `control_request` (a permission prompt), `control_response` |

### Event mapping

| Claude Code | MIKE event |
|---|---|
| `stream_event` → `text_delta` | `token` |
| `stream_event` → `thinking_delta` | `reasoning` |
| `assistant` → `tool_use` block | `tool_call` |
| `user` → `tool_result` block | `tool_result` |
| `system` / `init`, model change, `compact_boundary`, `api_retry`, `permission_denied` | `status` |
| `result` | `stats` (usage, then cost) and `persist` with `status: idle` |
| `control_request` | `status` carrying `ui_request_method` / `ui_request_id` |

An `assistant` or `user` message whose `parent_tool_use_id` is set belongs to a **sub-agent's** run, and
is dropped: this turn's rows are joined by `tool_use_id`, so a sub-agent's tool calls would be drawn as
the task's own work. What the sub-agent produced arrives in the main conversation as the `tool_result`
of the `Agent` call that started it.

An assembled `assistant` message repeats what its deltas already streamed, so its text and thinking
reach the chat **only when no delta carried them** — which is what makes the adapter work with or
without `--include-partial-messages` without ever saying the same sentence twice.

### Tool rendering

MIKE's chat renders a card per *MIKE* tool name and reads fixed argument keys, so a tool that MIKE
has a card for is renamed **and** its arguments are reshaped. A rename alone would leave the card
looking for a `path` that Claude Code spelled `file_path`.

| Claude Code | MIKE name | Arguments |
|---|---|---|
| `Read` | `read_file` | `file_path` → `path` (`offset`, `limit` kept) |
| `Write` | `write_file` | `file_path` → `path`, `content` |
| `Edit`, `NotebookEdit` | `edit_file` | `edits[]` rebuilt as `{oldText,newText}`; `notebook_path` counts as the path |
| `Bash` | `bash` | `command`, `description` |
| `Agent` | *(none)* | a sub-agent, **not** a kanban `create_task` |
| `Glob`, `Grep`, `Monitor`, `Skill`, `LSP`, `TodoWrite`, `TaskCreate` …, `WebFetch`, … | *(none)* | passed through, titled from their own name |

The names are the ones the CLI's [tool reference](https://code.claude.com/docs/en/tools-reference) lists;
anything else the model calls still renders, titled from its own name. Granting a name the CLI does not
have grants nothing, so this table follows the reference rather than its history.

`TaskCreate` and its siblings are Claude Code's own checklist tools; they render as plan steps and never
touch MIKE's board.

### Permissions

Nothing in MIKE's pipeline may park a turn on a permission prompt, so the run is launched in
**`dontAsk`** mode with the tools a coding turn lives on granted in one `--allowedTools` list
(`tools.go`). In this mode every action that would have prompted is **denied** instead of asked, and the
denial is not silent: it arrives as a `permission_denied` message and is counted on the turn's summary.
The container is the boundary, the same one a task's own shell has.

`--dangerously-skip-permissions` is deliberately **not** used. Its documented recipe asks for a container
*and a non-root user* on Linux and macOS, and MIKE's task containers run as root; and its extra reach
would buy nothing, since the allow-list already covers the work a coding turn does.

To let a run do something the list does not cover, add a `permissions.allow` rule to the `settings.json`
inside the mounted `~/.claude` — a rule there is honoured by this mode. Changing `tools.go` also works,
and needs a rebuild.

If a permission prompt still arrives (someone narrowed the flags), the adapter answers it with a **deny**
and says why. It never allows a tool on a person's behalf, and it never leaves a request unanswered,
because an unanswered `control_request` parks the turn on a socket nobody is coming back to.

### Cost, stats, model

- Cost arrives once per turn on `result.total_cost_usd`, reported as a stats event **without** a
  context window. That pairing is the runner's accumulation rule: a cost that arrives with a window
  replaces the session cost, one that arrives without it is added — so a two-turn run would report
  one turn if the two ever travelled together. `TestAdapter_CostNeverRidesWithAContextWindow` holds it.
- The CLI documents `total_cost_usd` as the cumulative estimate **for that call**, and a call that
  resumed a session folds in that session's earlier spend. This adapter never resumes, so adding one
  figure per turn is the documented way to sum a multi-call session. Both the cost and the token counts
  are the CLI's estimates, not a bill from the provider.
- Usage travels on the assistant rows that get persisted, and as a separate stats event when the CLI
  declared a context window (`modelUsage[].contextWindow`, which is what fills MIKE's context bar).
  Where it did not, the bar stays empty rather than guessing a model's size.
- The model is discovered from `system`/`init` and from each message's `model`, and is announced
  again when it changes. `set_model` sends the name with any `provider/` prefix dropped: MIKE spells
  a model `provider/id`, Claude Code names models by themselves.

## What this adapter does not do

| Command | Why |
|---|---|
| `compact` | No control subtype carries it. Claude Code compacts on its own when the window fills; MIKE's Compact action reports a timeout. |
| `stats` (on demand) | Nothing to ask. Every turn's `result` pushes usage, and the runner answers a query from the last one it holds. |
| `switch_session` | Resuming means spawning with `--resume`, and the runner starts the process before any session id exists. A run after a restart gets MIKE's own transcript of the task instead — the fallback the executor already implements. |
| `ListModels` | The CLI has no model listing, so the provider's model list is typed by hand. |

## Building

```bash
cd agent/claude-code
./build.sh          # GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared
go test ./...       # the adapter's own tests, run natively
```

Requires Go 1.24+ for the WASI reactor build. `claude-code.wasm` is committed next to its source, and
nothing checks that it matches: rebuild it in the same commit as any change to `adapter.go`.

To exercise the module through MIKE's real host, copy the artifact where its loader looks and drive
it from `backend/agent` (see `wasm_integration_test.go` for the shape):

```bash
mkdir -p <MIKE>/extensions/agent/claude-code
cp claude-code.wasm <MIKE>/extensions/agent/claude-code/
```

## Sandbox image

The image must have `claude` on `$PATH`; see `dockerfile-example/claude-code.Dockerfile`. The
manifest proposes one host mount, `~/.claude`, which holds the login — so it also holds everything
else that directory's owner configured: MCP servers, hooks, sub-agents. Grant it knowingly, or
authenticate with `ANTHROPIC_API_KEY` in the extension's environment instead.

## Publishing

`registry.json` is generated and pins each extension to a commit, so a new extension is published in
two steps and in this order:

```bash
cd ../MIKE-extensions && git add agent/claude-code && git commit   # you commit, not the tooling
cd <MIKE> && python3 scripts/gen-registry.py                       # the pin can now name committed content
```

Running the generator before that commit fails on purpose: a pin can only point at committed content.

## Verifying against a live CLI

The transport above is Claude Code's documented headless interface, and the message shapes are read
from the documentation pages named under *Transport* — including `permission_denied`, `api_retry`,
`compact_boundary`, `permission_denials` and `modelUsage[].contextWindow`, whose fields those pages
list. **`claude` was not installed on the machine this adapter was written on**, so the fixtures in
`adapter_test.go` are transcriptions of those pages rather than captures of a real stream. What still
needs one, in the order that would hurt most:

```bash
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-mode dontAsk \
  --allowedTools "Read,Write,Edit,Grep,Glob,Bash" <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"read go.mod"}]},"session_id":"default"}
EOF
```

1. **Whether `total_cost_usd` accumulates across the messages of one streaming-input process.** The
   cost page documents the figure as cumulative *for a call* and cumulative *from a resumed session*;
   one process answering several user messages sits between those two cases. Send two messages and
   compare the second figure with the sum of both. If the second is the larger, the run is already
   reported too high — `parseResult` must then report the latest figure instead of adding each one.
2. **What an `interrupt` leaves behind.** That a mid-turn interrupt ends the turn with a `result` (and
   which `subtype`) rather than the process, and whether anything arrives after it.
3. **A model switch mid-session** — whether `set_model` is answered at all in this mode, and whether the
   following message's `model` confirms it. A refusal is already shown as a status, never as an error.
4. **`initialize`'s response payload** — whether it names a model. The adapter works either way.
5. **`can_use_tool`** — the exact refusal body. Only reachable with narrowed flags.

## Files

| File | Description |
|------|-------------|
| `adapter.go` | Protocol adapter (pure Go, no backend imports) |
| `types.go`, `helpers.go`, `tools.go` | Wire shapes, payload readers, tool rendering |
| `adapter_test.go` | Adapter unit tests (native) |
| `wasm/main.go` | WASI reactor with `//go:wasmexport` functions |
| `manifest.json` | Extension metadata, config schema, WASM module path |
| `build.sh` | Builds `claude-code.wasm` |
| `dockerfile-example/` | A sandbox image with `claude` on `$PATH` |
