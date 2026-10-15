package claudecode

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"mike/pkg/agent"
)

// The adapter's unit tests run natively (no wazero): adapter.go imports nothing from backend/.
// The WASM module's own load test lives in MIKE's backend/agent (docs/agent-extensions.md).

func initAdapter(t *testing.T, cfg string) *Adapter {
	t.Helper()
	a := NewAdapter()
	if cfg == "" {
		cfg = `{"session_name":"kanban-frost-amber"}`
	}
	if err := a.Init(context.Background(), []byte(cfg)); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return a
}

// parse feeds whole lines and returns the events they produced.
func parse(t *testing.T, a *Adapter, lines ...string) []agent.Event {
	t.Helper()
	var chunk strings.Builder
	for _, l := range lines {
		chunk.WriteString(l)
		chunk.WriteByte('\n')
	}
	return a.ParseOutput(context.Background(), []byte(chunk.String()))
}

// decodeLine reads one protocol line the adapter encoded.
func decodeLine(t *testing.T, data []byte) map[string]any {
	t.Helper()
	if len(data) == 0 {
		t.Fatal("expected a protocol line, got none")
	}
	if data[len(data)-1] != '\n' {
		t.Fatalf("protocol line is not newline-terminated: %q", data)
	}
	var msg map[string]any
	if err := json.Unmarshal(data[:len(data)-1], &msg); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return msg
}

// controlSubtype reads request.subtype out of an encoded control_request.
func controlSubtype(t *testing.T, data []byte) string {
	t.Helper()
	msg := decodeLine(t, data)
	if msg["type"] != "control_request" {
		t.Fatalf("expected a control_request, got %v", msg["type"])
	}
	req, _ := msg["request"].(map[string]any)
	sub, _ := req["subtype"].(string)
	return sub
}

// requestID reads the id the adapter put on a control request, which is what the CLI echoes back.
func requestID(t *testing.T, data []byte) string {
	t.Helper()
	id, _ := decodeLine(t, data)["request_id"].(string)
	if id == "" {
		t.Fatal("control request carries no request_id")
	}
	return id
}

// modelEvent returns the first event that names a model, if any.
func modelEvent(events []agent.Event) *agent.Event {
	for i := range events {
		if events[i].RawData != nil {
			if _, ok := events[i].RawData["model_name"]; ok {
				return &events[i]
			}
		}
	}
	return nil
}

// eventTypes lists a batch's event kinds, for a failure message.
func eventTypes(events []agent.Event) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func TestAdapter_InitDefaults(t *testing.T) {
	a := initAdapter(t, `{}`)
	if a.config.Binary != "claude" {
		t.Errorf("Binary = %q, want claude", a.config.Binary)
	}
	if a.config.DisplayName != "Claude Code" {
		t.Errorf("DisplayName = %q, want Claude Code", a.config.DisplayName)
	}

	// The display name is configurable; the command is not — the image puts `claude` on PATH.
	overridden := initAdapter(t, `{"display_name":"CC"}`)
	if overridden.config.Binary != claudeBinary || overridden.config.DisplayName != "CC" {
		t.Errorf("config not applied: %+v", overridden.config)
	}

	if err := a.Init(context.Background(), []byte("not json")); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// TestAdapter_SubprocessConfigIsUnattended pins the argv a headless run needs: it survives its turns,
// streams text, and never stops at a permission prompt.
func TestAdapter_SubprocessConfigIsUnattended(t *testing.T) {
	a := initAdapter(t, `{"env":["PATH=/usr/bin"],"agent_manifest":{"sandbox":{"env":[{"key":"HOME","value":"/root"}]}}}`)

	cfg := a.SubprocessConfig(context.Background())
	if cfg.Binary != "claude" {
		t.Errorf("Binary = %q, want claude", cfg.Binary)
	}
	joined := strings.Join(cfg.Args, " ")
	for _, w := range []string{
		"-p", "--input-format stream-json", "--output-format stream-json",
		"--verbose", "--include-partial-messages", "--permission-mode dontAsk",
	} {
		if !strings.Contains(joined, w) {
			t.Errorf("args %v missing %q", cfg.Args, w)
		}
	}
	// dontAsk refuses whatever it was not granted, so this list is what the turn can do.
	granted := ""
	for i, arg := range cfg.Args {
		if arg == "--allowedTools" && i+1 < len(cfg.Args) {
			granted = cfg.Args[i+1]
		}
	}
	if granted == "" {
		t.Fatalf("args %v carry no --allowedTools value", cfg.Args)
	}
	for _, w := range []string{"Read", "Write", "Edit", "Grep", "Glob", "Bash"} {
		if !strings.Contains(granted, w) {
			t.Errorf("granted tools %q missing %s", granted, w)
		}
	}
	if strings.Contains(granted, "AskUserQuestion") {
		t.Errorf("granted tools %q include AskUserQuestion, which dontAsk denies whatever it is granted", granted)
	}
	// Bypass mode asks for a non-root session, and these containers run as root.
	if strings.Contains(joined, "--dangerously-skip-permissions") || strings.Contains(joined, "bypassPermissions") {
		t.Errorf("args %v use bypass permissions, which is documented for a non-root session", cfg.Args)
	}
	if !strings.Contains(strings.Join(cfg.Env, " "), "HOME=/root") {
		t.Errorf("manifest env not applied: %v", cfg.Env)
	}
	if !strings.Contains(strings.Join(cfg.Env, " "), "PATH=/usr/bin") {
		t.Errorf("runner env dropped: %v", cfg.Env)
	}
}

func TestAdapter_EncodePrompt(t *testing.T) {
	a := initAdapter(t, ``)
	data, _ := json.Marshal(map[string]any{"message": "fix the bug", "behavior": "steer"})

	msg := decodeLine(t, a.EncodeCommand(context.Background(), agent.CommandPrompt, data))
	if msg["type"] != "user" {
		t.Fatalf("type = %v, want user", msg["type"])
	}
	if msg["session_id"] != "default" {
		t.Errorf("session_id = %v, want default before the CLI names one", msg["session_id"])
	}
	body, _ := msg["message"].(map[string]any)
	if body["role"] != "user" {
		t.Fatalf("message.role = %v, want user", body["role"])
	}
	blocks, _ := body["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("content = %v, want one block", body["content"])
	}
	block, _ := blocks[0].(map[string]any)
	if block["type"] != "text" || block["text"] != "fix the bug" {
		t.Errorf("content block = %v", block)
	}

	// After a message names the session, the next prompt uses that id.
	a.sessionID = "7ba1-session"
	next := decodeLine(t, a.EncodeCommand(context.Background(), agent.CommandPrompt, data))
	if next["session_id"] != "7ba1-session" {
		t.Errorf("session_id = %v, want the discovered one", next["session_id"])
	}
}

// TestAdapter_EncodeModelSwitch drops the provider prefix: MIKE spells a model "provider/id" and
// Claude Code reads a slash as part of the name.
func TestAdapter_EncodeModelSwitch(t *testing.T) {
	a := initAdapter(t, ``)

	msg := decodeLine(t, a.EncodeCommand(context.Background(), agent.CommandSetModel,
		[]byte(`{"model_name":"anthropic/claude-sonnet-4-5"}`)))
	req, _ := msg["request"].(map[string]any)
	if req["subtype"] != "set_model" {
		t.Fatalf("subtype = %v", req["subtype"])
	}
	if req["model"] != "claude-sonnet-4-5" {
		t.Errorf("model = %v, want the bare id", req["model"])
	}

	bare := decodeLine(t, a.EncodeCommand(context.Background(), agent.CommandSetModel,
		[]byte(`{"model_name":"opus"}`)))
	req2, _ := bare["request"].(map[string]any)
	if req2["model"] != "opus" {
		t.Errorf("model = %v, want opus", req2["model"])
	}

	if got := a.EncodeCommand(context.Background(), agent.CommandSetModel, []byte(`{}`)); got != nil {
		t.Errorf("an empty model name should send nothing, got %s", got)
	}
}

// TestAdapter_ControlRequestsAreRemembered: the id the adapter sends is the id the CLI echoes back.
func TestAdapter_ControlRequestsAreRemembered(t *testing.T) {
	a := initAdapter(t, ``)

	if sub := controlSubtype(t, a.EncodeCommand(context.Background(), agent.CommandGetState, nil)); sub != "initialize" {
		t.Errorf("get_state → %q, want initialize", sub)
	}
	if sub := controlSubtype(t, a.EncodeCommand(context.Background(), agent.CommandAbort, nil)); sub != "interrupt" {
		t.Errorf("abort → %q, want interrupt", sub)
	}
	if len(a.pending) != 2 {
		t.Fatalf("pending = %v, want both requests recorded", a.pending)
	}
	for id, cmd := range a.pending {
		if !strings.HasPrefix(id, "cc-") || cmd == "" {
			t.Errorf("bad pending entry %q → %q", id, cmd)
		}
	}
}

// TestAdapter_CommandsWithoutACarrier covers the three commands this protocol cannot carry, each of
// which is answered elsewhere.
func TestAdapter_CommandsWithoutACarrier(t *testing.T) {
	a := initAdapter(t, ``)
	for _, cmd := range []string{agent.CommandCompact, agent.CommandStats, agent.CommandSwitchSession} {
		if got := a.EncodeCommand(context.Background(), cmd, []byte(`{}`)); got != nil {
			t.Errorf("%s encoded %s, want nothing", cmd, got)
		}
	}
	if got := a.EncodeCommand(context.Background(), "unknown_command", nil); got != nil {
		t.Errorf("unknown command encoded %s, want nothing", got)
	}
}

func TestAdapter_ParseOutputBuffersPartialLines(t *testing.T) {
	a := initAdapter(t, ``)

	partial := []byte(`{"type":"stream_event","event":{"type":"content_block_delta","de`)
	if events := a.ParseOutput(context.Background(), partial); len(events) != 0 {
		t.Fatalf("partial line produced %v, want nothing", eventTypes(events))
	}
	rest := []byte(`lta":{"type":"text_delta","text":"hi"}}}` + "\n")
	events := a.ParseOutput(context.Background(), rest)
	if len(events) != 1 || events[0].Text != "hi" {
		t.Fatalf("completed line: %+v", events)
	}
}

// TestAdapter_ParseOutputDropsAnUnterminatedLine is the bound that stops a byte stream exhausting the
// module's memory.
func TestAdapter_ParseOutputDropsAnUnterminatedLine(t *testing.T) {
	a := initAdapter(t, ``)

	a.ParseOutput(context.Background(), []byte(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"`+strings.Repeat("x", maxLineBytes)+`"}}}`))
	if len(a.lineBuffer) != 0 {
		t.Fatalf("buffer held %d bytes, want the oversize line dropped", len(a.lineBuffer))
	}
	events := parse(t, a, `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"clean"}}}`)
	if len(events) != 1 || events[0].Text != "clean" {
		t.Fatalf("parsing after the dropped line: %+v", events)
	}
}

func TestAdapter_ParseOutputToleratesGarbage(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `not json at all`, `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"kept"}}}`)
	if len(events) != 1 || events[0].Text != "kept" {
		t.Fatalf("a bad line took the good one with it: %+v", events)
	}
}

func TestAdapter_StreamDeltas(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t,
		a,
		`{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"let me look"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"reading"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"pa"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_stop","index":1}}`,
	)
	if len(events) != 2 {
		t.Fatalf("events = %v, want the two deltas only", eventTypes(events))
	}
	if events[0].Type != agent.EventTypeReasoning || events[0].Thinking != "let me look" {
		t.Errorf("reasoning event = %+v", events[0])
	}
	if events[1].Type != agent.EventTypeToken || events[1].Text != "reading" {
		t.Errorf("token event = %+v", events[1])
	}
}

// TestAdapter_ToolCallRendering is the reason a rename is not enough: MIKE's card reads `path`,
// `command` and `edits[].oldText`, and Claude Code spells all three differently.
func TestAdapter_ToolCallRendering(t *testing.T) {
	a := initAdapter(t, ``)

	cases := []struct {
		claude   string
		wantName string
		wantArgs string
	}{
		{
			claude:   `{"type":"tool_use","name":"Read","input":{"file_path":"backend/main.go","offset":10}}`,
			wantName: "read_file",
			wantArgs: `{"offset":10,"path":"backend/main.go"}`,
		},
		{
			claude:   `{"type":"tool_use","name":"Write","input":{"file_path":"a.txt","content":"hello"}}`,
			wantName: "write_file",
			wantArgs: `{"content":"hello","path":"a.txt"}`,
		},
		{
			claude:   `{"type":"tool_use","name":"Edit","input":{"file_path":"a.go","old_string":"one","new_string":"two"}}`,
			wantName: "edit_file",
			wantArgs: `{"edits":[{"newText":"two","oldText":"one"}],"path":"a.go"}`,
		},
		{
			claude:   `{"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"nb.ipynb","cell_id":"c3","new_source":"print(1)"}}`,
			wantName: "edit_file",
			wantArgs: `{"edits":[{"newText":"print(1)","oldText":""}],"path":"nb.ipynb"}`,
		},
		{
			claude:   `{"type":"tool_use","name":"Bash","input":{"command":"go test ./...","description":"run tests"}}`,
			wantName: "bash",
			wantArgs: `{"command":"go test ./...","description":"run tests"}`,
		},
		// A sub-agent is not a kanban card, and a search is not a MIKE tool: both keep their own name.
		{
			claude:   `{"type":"tool_use","name":"Agent","input":{"prompt":"audit this"}}`,
			wantName: "Agent",
			wantArgs: `{"prompt":"audit this"}`,
		},
		{
			claude:   `{"type":"tool_use","name":"Grep","input":{"pattern":"Foo","path":"backend"}}`,
			wantName: "Grep",
			wantArgs: `{"path":"backend","pattern":"Foo"}`,
		},
	}

	for _, tc := range cases {
		events := parse(t, a, `{"type":"assistant","message":{"role":"assistant","content":[`+tc.claude+`]}}`)
		if len(events) != 1 || events[0].Type != agent.EventTypeToolCall {
			t.Fatalf("%s: events = %v", tc.claude, eventTypes(events))
		}
		got := events[0].ToolCall
		if got.Name != tc.wantName {
			t.Errorf("%s: name = %q, want %q", tc.claude, got.Name, tc.wantName)
		}
		if got.DisplayName == "" {
			t.Errorf("%s: no display name", tc.claude)
		}
		if got.RawArgs != tc.wantArgs {
			t.Errorf("%s: args = %s, want %s", tc.claude, got.RawArgs, tc.wantArgs)
		}
	}
}

func TestAdapter_ToolDisplayNameTitlesUnknownTools(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ListMcpResources","input":{}}]}}`)
	if len(events) != 1 {
		t.Fatalf("events = %v", eventTypes(events))
	}
	if got := events[0].ToolCall.DisplayName; got != "List Mcp Resources" {
		t.Errorf("display name = %q", got)
	}
}

// TestAdapter_AssembledTextIsNotSaidTwice: with --include-partial-messages the deltas and the
// assembled message both carry the answer, and only one of them may reach the chat.
func TestAdapter_AssembledTextIsNotSaidTwice(t *testing.T) {
	a := initAdapter(t, ``)

	parse(t, a,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}`,
	)
	events := parse(t, a, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"done"}]}}`)
	if len(events) != 0 {
		t.Fatalf("assembled message repeated streamed content: %+v", events)
	}

	// Without partial messages the assembled copy is all there is, and it has to arrive.
	b := initAdapter(t, ``)
	events = parse(t, b, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"done"}]}}`)
	if len(events) != 2 {
		t.Fatalf("events = %v, want reasoning then text", eventTypes(events))
	}
	if events[0].Type != agent.EventTypeReasoning || events[1].Type != agent.EventTypeToken {
		t.Fatalf("event order = %v", eventTypes(events))
	}
	if events[1].Text != "done" {
		t.Errorf("text = %q", events[1].Text)
	}
}

func TestAdapter_ModelDiscovery(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-4-5"}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("init events = %v", eventTypes(events))
	}
	if events[0].Status.State != "running" {
		t.Errorf("init must report a running agent, got %q", events[0].Status.State)
	}
	if events[0].RawData["model_name"] != "claude-sonnet-4-5" {
		t.Errorf("model_name = %v", events[0].RawData["model_name"])
	}
	if a.sessionID != "s-1" {
		t.Errorf("session id = %q", a.sessionID)
	}

	// A model that has not changed is not reported again.
	same := parse(t, a, `{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`)
	if e := modelEvent(same); e != nil {
		t.Fatalf("repeat model announcement: %+v", e)
	}
	changed := parse(t, a, `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-1","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{}}]}}`)
	e := modelEvent(changed)
	if e == nil || e.RawData["model_name"] != "claude-opus-4-1" {
		t.Fatalf("model change: %+v", changed)
	}
	if a.modelName != "claude-opus-4-1" {
		t.Errorf("modelName = %q", a.modelName)
	}
}

func TestAdapter_ToolResultsComeBackOnUserMessages(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-1","content":"plain output"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-2","is_error":true,"content":[{"type":"text","text":"line one"},{"type":"text","text":"line two"}]}]}}`,
	)
	if len(events) != 2 {
		t.Fatalf("events = %v", eventTypes(events))
	}
	if events[0].ToolResult.Output != "plain output" || !events[0].ToolResult.Success {
		t.Errorf("string payload: %+v", events[0].ToolResult)
	}
	if events[1].ToolResult.Output != "line one\nline two" || events[1].ToolResult.Success {
		t.Errorf("block payload: %+v", events[1].ToolResult)
	}
	if got := a.current.toolResults["tu-2"]; got.Output != "line one\nline two" || got.Success {
		t.Errorf("result not kept for persistence: %+v", got)
	}
}

// TestAdapter_ResultEndsTheTurnAndPersistsIt is the turn-end contract: one persist with status idle,
// which is the executor's stop signal, plus a row per message and per tool call.
func TestAdapter_ResultEndsTheTurnAndPersistsIt(t *testing.T) {
	a := initAdapter(t, ``)

	parse(t, a, `{"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-4-5"}`)
	parse(t, a,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"thinking","thinking":"read it first"},{"type":"text","text":"let me read"},{"type":"tool_use","id":"tu-1","name":"Read","input":{"file_path":"main.go"}}],"usage":{"input_tokens":100,"output_tokens":20}}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-1","content":"package main"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"fixed"}],"usage":{"input_tokens":140,"output_tokens":8}}}`,
	)
	events := parse(t, a, `{"type":"result","subtype":"success","result":"fixed","total_cost_usd":0.042,"usage":{"input_tokens":140,"output_tokens":8,"cache_read_input_tokens":900},"modelUsage":{"claude-sonnet-4-5":{}}}`)

	if len(events) != 2 {
		t.Fatalf("events = %v, want stats then persist", eventTypes(events))
	}
	// No model declared a context window, so the only stats event is the one carrying the cost.
	stats := events[0]
	if stats.Type != agent.EventTypeStats {
		t.Fatalf("first event = %s", stats.Type)
	}
	if stats.Stats.Cost != 0.042 || stats.Stats.ContextWindow != 0 {
		t.Errorf("stats = %+v, want the turn cost and no context window", stats.Stats)
	}

	persist := events[1]
	if persist.Type != agent.EventTypePersist || persist.Status.State != "idle" {
		t.Fatalf("persist = %+v", persist)
	}
	if len(persist.PersistEntries) != 3 {
		t.Fatalf("entries = %d, want two assistant rows and one tool row: %+v", len(persist.PersistEntries), persist.PersistEntries)
	}

	first := persist.PersistEntries[0]
	if first.Role != "assistant" || first.Content != "let me read" || first.ReasoningContent != "read it first" {
		t.Errorf("first assistant row = %+v", first)
	}
	if first.ModelName != "claude-sonnet-4-5" || first.ProviderName != "Claude Code" {
		t.Errorf("provenance = %q / %q", first.ModelName, first.ProviderName)
	}
	if first.PromptTokens != 100 || first.PredictedTokens != 20 || first.Cost != 0 {
		t.Errorf("tokens/cost = %+v, want usage and no cost (cost is the stats event's)", first)
	}

	tool := persist.PersistEntries[1]
	if tool.Role != "tool_call" {
		t.Fatalf("second row = %q", tool.Role)
	}
	var call struct {
		ToolID   string         `json:"tool_id"`
		ToolName string         `json:"tool_name"`
		Args     map[string]any `json:"args"`
	}
	if err := json.Unmarshal([]byte(tool.ToolCallsJSON), &call); err != nil {
		t.Fatalf("tool call json: %v", err)
	}
	if call.ToolID != "tu-1" || call.ToolName != "read_file" || call.Args["path"] != "main.go" {
		t.Errorf("tool call = %+v", call)
	}
	var result struct {
		Output  string `json:"output"`
		Success bool   `json:"success"`
	}
	if err := json.Unmarshal([]byte(tool.ToolResultJSON), &result); err != nil {
		t.Fatalf("tool result json: %v", err)
	}
	if result.Output != "package main" || !result.Success {
		t.Errorf("tool result = %+v", result)
	}

	if last := persist.PersistEntries[2]; last.Content != "fixed" || last.PromptTokens != 140 {
		t.Errorf("last assistant row = %+v", last)
	}
}

// TestAdapter_CostNeverRidesWithAContextWindow holds the runner's accumulation rule: a cost arriving
// with a window replaces its session cost, one arriving without is added. Together they would make a
// two-turn run report one turn.
func TestAdapter_CostNeverRidesWithAContextWindow(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"result","subtype":"success","result":"x","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":2},"modelUsage":{"claude-sonnet-4-5":{"contextWindow":200000}}}`)
	if len(events) != 3 {
		t.Fatalf("events = %v, want window stats, cost stats, persist", eventTypes(events))
	}
	window, cost := events[0].Stats, events[1].Stats
	if window.ContextWindow != 200000 || window.Cost != 0 {
		t.Errorf("window stats carried a cost: %+v", window)
	}
	if window.ContextTokens != 12 || window.ContextPercent <= 0 {
		t.Errorf("context = %d tokens, %f%%", window.ContextTokens, window.ContextPercent)
	}
	if cost.ContextWindow != 0 || cost.Cost != 0.5 {
		t.Errorf("cost stats carried a window: %+v", cost)
	}
}

// TestAdapter_ARefusedModelSwitchIsNotAnErrorEvent: the executor fails the task on an error event
// before its first token, and a model name this CLI does not know is not worth failing a task for.
func TestAdapter_ARefusedModelSwitchIsNotAnErrorEvent(t *testing.T) {
	a := initAdapter(t, ``)

	encoded := a.EncodeCommand(context.Background(), agent.CommandSetModel, []byte(`{"model_name":"gpt-not-here"}`))
	id := requestID(t, encoded)

	events := parse(t, a, `{"type":"control_response","response":{"subtype":"error","request_id":"`+id+`","error":"Model not found"}}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("events = %+v, want one status", events)
	}
	if !strings.Contains(events[0].Status.Activity, "Model not found") {
		t.Errorf("refusal not reported: %q", events[0].Status.Activity)
	}
	if _, ok := events[0].RawData["model_name"]; ok {
		t.Error("a refused switch must not report a model")
	}
	if len(a.pending) != 0 {
		t.Errorf("request left pending: %v", a.pending)
	}
}

func TestAdapter_AcceptedModelSwitchReportsItsModel(t *testing.T) {
	a := initAdapter(t, ``)

	encoded := a.EncodeCommand(context.Background(), agent.CommandSetModel, []byte(`{"model_name":"opus"}`))
	id := requestID(t, encoded)

	events := parse(t, a, `{"type":"control_response","response":{"subtype":"success","request_id":"`+id+`"}}`)
	if len(events) != 1 || events[0].RawData["model_name"] != "opus" {
		t.Fatalf("events = %+v, want the model the CLI accepted", events)
	}
	if a.modelName != "opus" {
		t.Errorf("modelName = %q", a.modelName)
	}
}

// TestAdapter_StateResponseNamesAModelOrEndsTheWait keeps QueryModel from waiting out its three
// seconds at task start: the initialize response says the CLI is there, and names a model if it has one.
func TestAdapter_StateResponseNamesAModelOrEndsTheWait(t *testing.T) {
	a := initAdapter(t, ``)
	id := requestID(t, a.EncodeCommand(context.Background(), agent.CommandGetState, nil))

	events := parse(t, a, `{"type":"control_response","response":{"subtype":"success","request_id":"`+id+`","response":{"model":"claude-haiku-4-5"}}}`)
	if len(events) != 1 || events[0].RawData["model_name"] != "claude-haiku-4-5" {
		t.Fatalf("events = %+v", events)
	}

	// A response that names nothing still says the CLI answered, which is enough for startup.
	b := initAdapter(t, ``)
	id = requestID(t, b.EncodeCommand(context.Background(), agent.CommandGetState, nil))
	events = parse(t, b, `{"type":"control_response","response":{"subtype":"success","request_id":"`+id+`","response":{"commands":["/compact"]}}}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus || events[0].Status.State != "running" {
		t.Fatalf("events = %+v, want a running status", events)
	}
	if _, ok := events[0].RawData["model_name"]; ok {
		t.Error("invented a model name out of a response that had none")
	}
}

// TestAdapter_PermissionRequestIsAnswered: an unanswered control_request parks the turn forever.
func TestAdapter_PermissionRequestIsAnswered(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"}}}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("events = %+v", events)
	}
	if events[0].RawData["ui_request_id"] != "req-9" || events[0].RawData["ui_request_method"] != "can_use_tool" {
		t.Fatalf("the runner cannot route this answer: %+v", events[0].RawData)
	}

	resp := decodeLine(t, a.HandleUIRequest(context.Background(), "req-9", "can_use_tool"))
	body, _ := resp["response"].(map[string]any)
	if body["request_id"] != "req-9" {
		t.Errorf("answer does not name the request it answers: %v", body)
	}
	inner, _ := body["response"].(map[string]any)
	if inner["behavior"] != "deny" {
		t.Errorf("behavior = %v, want deny", inner["behavior"])
	}
}

func TestAdapter_AnUnknownRequestIsRefusedRatherThanIgnored(t *testing.T) {
	a := initAdapter(t, ``)

	resp := decodeLine(t, a.HandleUIRequest(context.Background(), "req-3", "hook_callback"))
	body, _ := resp["response"].(map[string]any)
	if body["subtype"] != "error" || body["request_id"] != "req-3" {
		t.Errorf("answer = %v", body)
	}
}

func TestAdapter_UnknownMessagesBecomeStatus(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"some_future_message","foo":1}`, `{"type":"keep_alive"}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("events = %+v, want one status and silence for keep_alive", events)
	}
	if !strings.Contains(events[0].Status.Activity, "some_future_message") {
		t.Errorf("activity = %q", events[0].Status.Activity)
	}
}

// TestAdapter_AResultThatWillNotParseStillEndsTheTurn: without the persist event the task waits
// forever.
func TestAdapter_AResultThatWillNotParseStillEndsTheTurn(t *testing.T) {
	a := initAdapter(t, ``)

	events := a.ParseOutput(context.Background(), []byte(`{"type":"result","total_cost_usd":"not a number"}`+"\n"))
	if len(events) != 1 || events[0].Type != agent.EventTypePersist || events[0].Status.State != "idle" {
		t.Fatalf("events = %+v, want an idle persist", events)
	}
}

func TestAdapter_StreamsWhatNeverAssembled(t *testing.T) {
	a := initAdapter(t, ``)

	parse(t, a,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"half an answer"}}}`,
	)
	events := parse(t, a, `{"type":"result","subtype":"success","total_cost_usd":0.01}`)
	if len(events) != 2 || events[1].Type != agent.EventTypePersist {
		t.Fatalf("events = %v", eventTypes(events))
	}
	entries := events[1].PersistEntries
	if len(entries) != 1 || entries[0].Content != "half an answer" {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].ModelName != "claude" {
		t.Errorf("model = %q, want the binary name as the fallback", entries[0].ModelName)
	}
}

// TestAdapter_TurnStateEndsWithTheResult keeps a follow-up turn from persisting the previous turn's
// messages a second time.
func TestAdapter_TurnStateEndsWithTheResult(t *testing.T) {
	a := initAdapter(t, ``)

	parse(t, a, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}`)
	parse(t, a, `{"type":"result","subtype":"success","result":"first"}`)
	if len(a.current.assistants) != 0 {
		t.Fatalf("turn state survived its result: %+v", a.current.assistants)
	}

	a.EncodeCommand(context.Background(), agent.CommandPrompt, []byte(`{"message":"and now?"}`))
	events := parse(t, a, `{"type":"result","subtype":"success","result":"second"}`)
	if len(events) != 1 || events[0].Type != agent.EventTypePersist {
		t.Fatalf("events = %v, want one persist", eventTypes(events))
	}
	// Nothing carried over from the first turn, and what is left is this turn's own summary.
	entries := events[0].PersistEntries
	if len(entries) != 1 || entries[0].Content != "second" {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestAdapter_CloseClearsState(t *testing.T) {
	a := initAdapter(t, ``)

	a.EncodeCommand(context.Background(), agent.CommandGetState, nil)
	a.ParseOutput(context.Background(), []byte(`{"type":"assistant"`))
	a.Close()

	if a.lineBuffer != "" || len(a.pending) != 0 || len(a.current.assistants) != 0 {
		t.Errorf("state left behind: buffer=%q pending=%v assistants=%v", a.lineBuffer, a.pending, a.current.assistants)
	}
}

// TestAdapter_PermissionDenialIsShown: a refusal leaves no tool call in the transcript, so a reviewer
// has to be able to see that the work stopped here.
func TestAdapter_PermissionDenialIsShown(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"t1","decision_reason":"Bash(git push) is not in the allow list","message":"Permission to use Bash has been denied","session_id":"s"}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("events = %+v, want one status", events)
	}
	got := events[0].Status.Activity
	if !strings.Contains(got, "Bash") || !strings.Contains(got, "allow list") {
		t.Errorf("activity = %q, want the refused tool and the reason", got)
	}
}

// TestAdapter_ApiRetryIsNamed: the stream is quiet for the length of the backoff.
func TestAdapter_ApiRetryIsNamed(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"system","subtype":"api_retry","attempt":2,"max_retries":5,"error":"rate_limit","uuid":"u","session_id":"s"}`)
	if len(events) != 1 || events[0].Type != agent.EventTypeStatus {
		t.Fatalf("events = %+v, want one status", events)
	}
	got := events[0].Status.Activity
	if !strings.Contains(got, "2/5") || !strings.Contains(got, "rate_limit") {
		t.Errorf("activity = %q, want the attempt count and the error category", got)
	}
}

func TestAdapter_CompactBoundaryNamesItsTrigger(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a, `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":180000},"uuid":"u","session_id":"s"}`)
	if len(events) != 1 || !strings.Contains(events[0].Status.Activity, "auto") {
		t.Fatalf("events = %+v, want a status naming the trigger", events)
	}
}

// TestAdapter_SubAgentWorkIsNotThisTurnsWork: a sub-agent's tool results join this turn's rows by
// tool_use_id, so taking them would draw another run's work as the task's own.
func TestAdapter_SubAgentWorkIsNotThisTurnsWork(t *testing.T) {
	a := initAdapter(t, ``)

	events := parse(t, a,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"agent-1","name":"Agent","input":{"prompt":"dig"}}]},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"subagent chatter"},{"type":"tool_use","id":"inner-1","name":"Grep","input":{"pattern":"x"}}]},"parent_tool_use_id":"agent-1"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"inner-1","content":"subagent result"}]},"parent_tool_use_id":"agent-1"}`,
	)
	for _, e := range events {
		if e.Type == agent.EventTypeToken && strings.Contains(e.Text, "subagent") {
			t.Errorf("a sub-agent's text reached the chat: %q", e.Text)
		}
		if e.Type == agent.EventTypeToolCall && e.ToolCall.ID == "inner-1" {
			t.Error("a sub-agent's tool call was rendered as this turn's work")
		}
		if e.Type == agent.EventTypeToolResult && e.ToolResult.ID == "inner-1" {
			t.Error("a sub-agent's tool result was joined into this turn")
		}
	}
	if len(events) != 1 || events[0].ToolCall.ID != "agent-1" {
		t.Fatalf("events = %+v, want only the Agent tool call of the main conversation", events)
	}
	if events[0].ToolCall.DisplayName != "Subagent" {
		t.Errorf("display name = %q", events[0].ToolCall.DisplayName)
	}
}

func TestAdapter_ResultCountsWhatTheRunWasRefused(t *testing.T) {
	a := initAdapter(t, ``)

	parse(t, a, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done as far as I could"}]}}`)
	events := parse(t, a, `{"type":"result","subtype":"success","is_error":false,"result":"done as far as I could","total_cost_usd":0.02,"num_turns":1,"permission_denials":[{"tool_name":"Bash","tool_use_id":"t1","tool_input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}`)

	persist := events[len(events)-1]
	if persist.Type != agent.EventTypePersist {
		t.Fatalf("last event = %+v, want the persist that ends the turn", persist)
	}
	if !strings.Contains(persist.Status.Activity, "1 refused (Bash)") {
		t.Errorf("activity = %q, want the refused count and the tool named", persist.Status.Activity)
	}
}
