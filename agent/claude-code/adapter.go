// Package claudecode implements the Claude Code protocol adapter: Claude Code's stream-json transport
// in, MIKE's agent events out. It imports nothing from backend/, so it compiles to WASM.
package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"mike/pkg/agent"
)

// maxLineBytes bounds one JSONL line. The buffer lives in the WASM module's own memory, so an
// unbounded line would exhaust that memory and kill the module.
const maxLineBytes = 8 << 20

// The adapter names its own executable; the sandbox image puts it on PATH.
const (
	claudeBinary      = "claude"
	claudeDisplayName = "Claude Code"
)

// Adapter is the Claude Code protocol adapter: wasm/main.go exports one function per method and is the
// only caller, so this type satisfies no interface of its own. State lives across calls, which the
// host serializes with its adapter mutex.
type Adapter struct {
	config     ccConfig
	lineBuffer string
	cmdID      int
	// pending maps a control_request id to the command it carries, so a response can be attributed.
	pending map[string]string
	// modelName is discovered from an init or assistant message, or from an accepted set_model.
	modelName string
	// requestedModel is the name the last set_model asked for; the CLI agrees without echoing it back.
	requestedModel string
	// sessionID is the CLI's own session id. It is not offered to the runner as a session file:
	// resuming means spawning with --resume, and the process is already up.
	sessionID string
	current   turn
}

// NewAdapter returns an adapter holding its default configuration.
func NewAdapter() *Adapter {
	return &Adapter{
		config: ccConfig{
			Binary:      claudeBinary,
			DisplayName: claudeDisplayName,
		},
		pending: map[string]string{},
		current: newTurn(),
	}
}

// Init parses the runner's config JSON.
func (a *Adapter) Init(_ context.Context, config []byte) error {
	var cfg struct {
		DisplayName   string   `json:"display_name"`
		Env           []string `json:"env"`
		AgentManifest *struct {
			Sandbox *struct {
				// Only the environment is read here; the sandbox applies the mount.
				Env []struct {
					Key   string `json:"key"`
					Value string `json:"value"`
				} `json:"env,omitempty"`
			} `json:"sandbox,omitempty"`
		} `json:"agent_manifest,omitempty"`
	}
	if err := json.Unmarshal(config, &cfg); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	cmEnvs := []envVar{}
	if cfg.AgentManifest != nil && cfg.AgentManifest.Sandbox != nil {
		for _, e := range cfg.AgentManifest.Sandbox.Env {
			cmEnvs = append(cmEnvs, envVar{Key: e.Key, Value: e.Value})
		}
	}

	a.config = ccConfig{
		Binary:      claudeBinary,
		DisplayName: defaultString(cfg.DisplayName, claudeDisplayName),
		Env:         cfg.Env,
		SandboxEnvs: cmEnvs,
	}
	a.lineBuffer = ""
	a.cmdID = 0
	a.pending = map[string]string{}
	a.modelName = ""
	a.requestedModel = ""
	a.sessionID = ""
	a.current = newTurn()
	return nil
}

// SubprocessConfig returns the agent process configuration. One process stays up across a run's turns;
// a fresh `claude -p` per turn would lose the context every follow-up needs.
func (a *Adapter) SubprocessConfig(_ context.Context) agent.SubprocessConfig {
	// Unattended: nothing may wait on a permission prompt, so the run starts in dontAsk, which refuses
	// whatever it was not granted. Bypass mode goes unused: the CLI documents it for a non-root session,
	// and these containers run as root.
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", "dontAsk",
		"--allowedTools", allowedToolsArg(),
	}
	env := a.config.Env
	// A sandbox container already gets these from its grant, so appending them only matters for a host
	// run.
	for _, e := range a.config.SandboxEnvs {
		if e.Key != "" {
			env = append(env, e.Key+"="+e.Value)
		}
	}
	return agent.SubprocessConfig{
		Binary: a.config.Binary,
		Args:   args,
		Env:    env,
	}
}

// EncodeCommand turns a MIKE command into Claude Code JSONL. A nil return means this protocol cannot
// carry it, and each case says what answers instead.
func (a *Adapter) EncodeCommand(_ context.Context, cmd string, data []byte) []byte {
	a.cmdID++
	id := fmt.Sprintf("cc-%s-%d", cmd, a.cmdID)

	switch cmd {
	case agent.CommandPrompt:
		var d struct {
			Message  string `json:"message"`
			Behavior string `json:"behavior"`
		}
		if data != nil {
			if err := json.Unmarshal(data, &d); err != nil {
				log.Printf("[claude-code-adapter] EncodeCommand: failed to unmarshal prompt data: %v", err)
			}
		}
		// A new prompt opens a new turn, so the records the next `result` persists are this turn's.
		a.current = newTurn()
		// `behavior` ("steer") has no equivalent: the CLI queues a message written to a running turn.
		line := map[string]any{
			"type": "user",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": d.Message}},
			},
			"parent_tool_use_id": nil,
			"session_id":         defaultString(a.sessionID, "default"),
		}
		return jsonLine(line)

	case agent.CommandGetState:
		// The handshake is also the liveness probe: the executor's wait ends when this response arrives.
		return a.remember(id, cmd, controlRequest(id, "initialize", nil))

	case agent.CommandSetModel:
		var d struct {
			ModelName string `json:"model_name"`
			Provider  string `json:"provider"`
		}
		if data != nil {
			json.Unmarshal(data, &d)
		}
		model := d.ModelName
		if model == "" {
			return nil
		}
		// MIKE spells a model "provider/id"; Claude Code reads a slash as part of the name, so the id
		// alone is sent.
		if idx := strings.LastIndex(model, "/"); idx > 0 {
			model = model[idx+1:]
		}
		a.requestedModel = model
		return a.remember(id, cmd, controlRequest(id, "set_model", map[string]any{"model": model}))

	case agent.CommandAbort:
		// Written before the runner closes stdin, so an interrupted turn stops cleanly.
		return a.remember(id, cmd, controlRequest(id, "interrupt", nil))

	case agent.CommandCompact:
		// Claude Code compacts on its own; no control subtype carries MIKE's request.
		log.Printf("[claude-code-adapter] compact is not supported; the CLI compacts automatically")
		return nil

	case agent.CommandStats:
		// Nothing to ask: each turn's `result` pushes usage, and the runner answers from the last event
		// it holds.
		return nil

	case agent.CommandSwitchSession:
		// Resuming means spawning with --resume, which a running process cannot do. Returning nil makes
		// the executor replay the task's transcript.
		return nil
	}

	return nil
}

// remember records a control request so its response can be attributed, and returns the line.
func (a *Adapter) remember(id, command string, msg map[string]any) []byte {
	a.pending[id] = command
	return jsonLine(msg)
}

// jsonLine marshals one protocol message and terminates it.
func jsonLine(msg map[string]any) []byte {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[claude-code-adapter] encode: %v", err)
		return nil
	}
	return append(data, '\n')
}

// ParseOutput parses Claude Code JSONL stdout into generic agent events.
func (a *Adapter) ParseOutput(_ context.Context, data []byte) []agent.Event {
	a.lineBuffer += string(data)
	var events []agent.Event

	for {
		idx := strings.IndexByte(a.lineBuffer, '\n')
		if idx < 0 {
			break
		}
		line := strings.TrimRight(a.lineBuffer[:idx], "\r")
		a.lineBuffer = a.lineBuffer[idx+1:]
		if line == "" {
			continue
		}

		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &head); err != nil {
			log.Printf("[claude-code-adapter] ParseOutput: failed to parse JSON line (%d bytes): %v", len(line), err)
			continue
		}
		events = append(events, a.parseEvent(head.Type, json.RawMessage(line))...)
	}

	// An unterminated line over the bound is not a line, so it is dropped; the log records its size.
	if len(a.lineBuffer) > maxLineBytes {
		log.Printf("[claude-code-adapter] ParseOutput: dropped %d bytes of an unterminated line", len(a.lineBuffer))
		a.lineBuffer = ""
	}
	return events
}

// parseEvent turns one protocol line into the events it contributes.
func (a *Adapter) parseEvent(eventType string, raw json.RawMessage) []agent.Event {
	switch eventType {
	case "system":
		return a.parseSystem(raw)
	case "stream_event":
		return a.parseStreamEvent(raw)
	case "assistant":
		return a.parseAssistant(raw)
	case "user":
		return a.parseUser(raw)
	case "result":
		return a.parseResult(raw)
	case "control_response":
		return a.parseControlResponse(raw)
	case "control_request":
		return a.parseControlRequest(raw)
	case "auth_tokens", "keep_alive":
		return nil
	default:
		return []agent.Event{{
			Type:   agent.EventTypeStatus,
			Status: agent.StatusData{State: "running", Activity: fmt.Sprintf("Claude Code: %s", eventType)},
		}}
	}
}

func (a *Adapter) parseSystem(raw json.RawMessage) []agent.Event {
	var sys ccSystem
	if err := json.Unmarshal(raw, &sys); err != nil {
		log.Printf("[claude-code-adapter] parseSystem: %v", err)
		return nil
	}
	if sys.SessionID != "" {
		a.sessionID = sys.SessionID
	}
	switch sys.Subtype {
	case "init":
		activity := a.config.DisplayName + " started"
		var data map[string]any
		if sys.Model != "" {
			a.modelName = sys.Model
			activity += " · " + sys.Model
			data = map[string]any{"model_name": sys.Model}
		}
		return []agent.Event{{
			Type:    agent.EventTypeStatus,
			Status:  agent.StatusData{State: "running", Activity: activity},
			RawData: data,
		}}
	case "compact_boundary":
		// The CLI rewrote its own context; MIKE's compact action did not cause it.
		activity := "Context compacted"
		if sys.CompactMetadata.Trigger != "" {
			activity += " · " + sys.CompactMetadata.Trigger
		}
		return []agent.Event{{
			Type:   agent.EventTypeStatus,
			Status: agent.StatusData{State: "running", Activity: activity},
		}}
	case "api_retry":
		// The stream is silent for the length of the backoff, so the status says what is happening.
		activity := fmt.Sprintf("Retrying the provider call (%d/%d)", sys.Attempt, sys.MaxRetries)
		if sys.ErrorCategory != "" {
			activity += " · " + sys.ErrorCategory
		}
		return []agent.Event{{
			Type:   agent.EventTypeStatus,
			Status: agent.StatusData{State: "running", Activity: activity},
		}}
	case "permission_denied":
		// A refused tool leaves no tool call in the transcript, so the status names where the work
		// stopped.
		name := sys.ToolName
		if name == "" {
			name = "a tool"
		}
		reason := sys.DecisionReason
		if reason == "" {
			reason = sys.Message
		}
		if reason == "" {
			reason = "not permitted in this run"
		}
		return []agent.Event{{
			Type:   agent.EventTypeStatus,
			Status: agent.StatusData{State: "running", Activity: a.config.DisplayName + " refused " + name + " · " + reason},
		}}
	default:
		return nil
	}
}

func (a *Adapter) parseStreamEvent(raw json.RawMessage) []agent.Event {
	var se ccStreamEvent
	if err := json.Unmarshal(raw, &se); err != nil {
		log.Printf("[claude-code-adapter] parseStreamEvent: %v", err)
		return nil
	}
	if se.Event.Type != "content_block_delta" {
		// These steps arrive again as an assembled message, which is what MIKE persists.
		return nil
	}
	switch se.Event.Delta.Type {
	case "text_delta":
		if se.Event.Delta.Text == "" {
			return nil
		}
		a.current.streamedText += se.Event.Delta.Text
		return []agent.Event{{Type: agent.EventTypeToken, Text: se.Event.Delta.Text}}
	case "thinking_delta":
		if se.Event.Delta.Thinking == "" {
			return nil
		}
		a.current.streamedThinking += se.Event.Delta.Thinking
		return []agent.Event{{Type: agent.EventTypeReasoning, Thinking: se.Event.Delta.Thinking}}
	default:
		// Argument fragments are ignored: the assembled message carries the full arguments.
		return nil
	}
}

// parseAssistant handles one assembled message.
func (a *Adapter) parseAssistant(raw json.RawMessage) []agent.Event {
	var msg ccMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Printf("[claude-code-adapter] parseAssistant: %v", err)
		return nil
	}
	body := msg.Message
	if msg.SessionID != "" {
		a.sessionID = msg.SessionID
	}
	if fromSubagent(msg) {
		return nil
	}

	var events []agent.Event

	if body.Model != "" && body.Model != a.modelName {
		a.modelName = body.Model
		events = append(events, agent.Event{
			Type:    agent.EventTypeStatus,
			Status:  agent.StatusData{State: "running", Activity: "Model " + body.Model},
			RawData: map[string]any{"model_name": body.Model},
		})
	}

	// Text and thinking arrive here only when no delta streamed them, so nothing reaches the chat twice.
	if a.current.streamedThinking == "" {
		if think := bodyThinking(body); think != "" {
			events = append(events, agent.Event{Type: agent.EventTypeReasoning, Thinking: think})
		}
	}
	if a.current.streamedText == "" {
		if text := bodyText(body); text != "" {
			events = append(events, agent.Event{Type: agent.EventTypeToken, Text: text})
		}
	}
	a.current.streamedText = ""
	a.current.streamedThinking = ""

	for _, use := range bodyToolUses(body) {
		kanbanName := mapToolName(use.Name)
		rendered := use.Name
		if kanbanName != "" {
			rendered = kanbanName
		}
		args := mapToolArgs(use.Name, kanbanName, use.Input)
		argsJSON, _ := json.Marshal(args)
		events = append(events, agent.Event{
			Type: agent.EventTypeToolCall,
			ToolCall: agent.ToolCallData{
				ID: use.ID, Name: rendered, DisplayName: toolDisplayName(use.Name),
				Args: args, RawArgs: string(argsJSON),
			},
		})
	}

	a.current.assistants = append(a.current.assistants, body)
	return events
}

// parseUser handles the message a tool's output arrives on.
func (a *Adapter) parseUser(raw json.RawMessage) []agent.Event {
	var msg ccMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Printf("[claude-code-adapter] parseUser: %v", err)
		return nil
	}
	if fromSubagent(msg) {
		return nil
	}
	var events []agent.Event
	for _, res := range bodyToolResults(msg.Message) {
		output := blockText(res.Content)
		success := !res.IsError
		if res.ToolUseID != "" {
			a.current.toolResults[res.ToolUseID] = ccToolResult{Output: output, Success: success}
		}
		events = append(events, agent.Event{
			Type:       agent.EventTypeToolResult,
			ToolResult: agent.ToolResultData{ID: res.ToolUseID, Output: output, Success: success},
		})
	}
	return events
}

// parseResult ends the turn: usage first, then the persist entry the executor waits for. The runner
// replaces its session cost with a stats cost carrying a context window and adds one that does not, so
// the two never travel together; both must precede the persist, which ends the run.
func (a *Adapter) parseResult(raw json.RawMessage) []agent.Event {
	var res ccResult
	if err := json.Unmarshal(raw, &res); err != nil {
		log.Printf("[claude-code-adapter] parseResult: %v", err)
		// A turn that will not parse still has to end, or the task waits forever.
		a.endTurn()
		return []agent.Event{{
			Type:   agent.EventTypePersist,
			Status: agent.StatusData{State: "idle", Activity: a.config.DisplayName + " finished (parse error)"},
		}}
	}
	if res.SessionID != "" {
		a.sessionID = res.SessionID
	}

	var events []agent.Event
	if win := largestContextWindow(res.ModelUsage); win > 0 {
		stats := sessionStats(res.Usage, win)
		events = append(events, agent.Event{Type: agent.EventTypeStats, Stats: stats})
	}
	// total_cost_usd is the CLI's estimate for this call. This adapter never resumes a session, so each
	// turn's figure is added once.
	if res.TotalCostUSD > 0 {
		events = append(events, agent.Event{
			Type:  agent.EventTypeStats,
			Stats: agent.SessionStatsData{Cost: res.TotalCostUSD},
		})
	}

	activity := a.config.DisplayName + " finished"
	if res.IsError || res.Subtype != "success" {
		activity = a.config.DisplayName + " ended: " + defaultString(res.Subtype, "unknown")
	}
	// The result repeats the refusals the turn already showed; the turn's summary counts them.
	if n := len(res.PermissionDenials); n > 0 {
		name := defaultString(res.PermissionDenials[0].ToolName, "a tool")
		activity += fmt.Sprintf(" · %d refused (%s)", n, name)
	}
	// An errored turn still persists what it produced.
	entries := a.buildPersistEntries()
	a.endTurn()
	if len(entries) == 0 && res.Result != "" {
		entries = []agent.PersistEntry{{
			Role: "assistant", Content: res.Result,
			ModelName: a.modelNameOrDefault(), ProviderName: a.config.DisplayName,
		}}
	}

	return append(events, agent.Event{
		Type:           agent.EventTypePersist,
		Status:         agent.StatusData{State: "idle", Activity: activity},
		PersistEntries: entries,
	})
}

// endTurn drops the turn's records, so a second result cannot persist the first turn again.
func (a *Adapter) endTurn() { a.current = newTurn() }

func (a *Adapter) parseControlResponse(raw json.RawMessage) []agent.Event {
	var cr ccControlResponse
	if err := json.Unmarshal(raw, &cr); err != nil {
		log.Printf("[claude-code-adapter] parseControlResponse: %v", err)
		return nil
	}
	command, ok := a.pending[cr.Response.RequestID]
	if !ok {
		return nil
	}
	delete(a.pending, cr.Response.RequestID)

	failed := cr.Response.Subtype == "error"
	if failed {
		log.Printf("[claude-code-adapter] %s rejected: %s", command, cr.Response.Error)
	}

	switch command {
	case agent.CommandSetModel:
		if failed {
			// A refused model is a status, not an error event: an error before the first token fails the
			// task, and an unknown model name should not.
			return []agent.Event{{
				Type:   agent.EventTypeStatus,
				Status: agent.StatusData{State: "running", Activity: "Model switch refused: " + cr.Response.Error},
			}}
		}
		model := modelFromResponse(cr.Response.Response)
		if model == "" {
			model = a.requestedModel
		}
		if model == "" {
			return nil
		}
		a.modelName = model
		return []agent.Event{{
			Type:    agent.EventTypeStatus,
			Status:  agent.StatusData{State: "running", Activity: "Model " + model},
			RawData: map[string]any{"model_name": model},
		}}

	case agent.CommandGetState:
		if failed {
			return nil
		}
		activity := a.config.DisplayName + " ready"
		var data map[string]any
		if m := modelFromResponse(cr.Response.Response); m != "" {
			a.modelName = m
			activity = "Model " + m
			data = map[string]any{"model_name": m}
		} else if a.modelName != "" {
			data = map[string]any{"model_name": a.modelName}
		}
		return []agent.Event{{
			Type:    agent.EventTypeStatus,
			Status:  agent.StatusData{State: "running", Activity: activity},
			RawData: data,
		}}

	}
	return nil
}

// parseControlRequest surfaces a request the CLI makes of the harness. Every one gets an answer, since
// an unanswered request parks the turn.
func (a *Adapter) parseControlRequest(raw json.RawMessage) []agent.Event {
	var cr ccControlRequest
	if err := json.Unmarshal(raw, &cr); err != nil {
		log.Printf("[claude-code-adapter] parseControlRequest: %v", err)
		return nil
	}
	activity := "Claude Code asked: " + defaultString(cr.Request.Subtype, "request")
	if cr.Request.ToolName != "" {
		activity = "Claude Code wants to run " + toolDisplayName(cr.Request.ToolName)
	}
	return []agent.Event{{
		Type:   agent.EventTypeStatus,
		Status: agent.StatusData{State: "running", Activity: activity},
		RawData: map[string]any{
			"ui_request_method": defaultString(cr.Request.Subtype, "request"),
			"ui_request_id":     cr.RequestID,
		},
	}}
}

// HandleUIRequest answers the CLI's requests, and refuses all of them. A permission prompt asks a
// person, and nothing reaches one mid-turn; a prompt arriving at all means someone narrowed the flags.
func (a *Adapter) HandleUIRequest(_ context.Context, id, method string) []byte {
	resp := map[string]any{"type": "control_response"}
	if method == "can_use_tool" {
		resp["response"] = map[string]any{
			"subtype":    "success",
			"request_id": id,
			"response": map[string]any{
				"behavior": "deny",
				"message": "MIKE does not answer Claude Code permission prompts mid-turn. " +
					"Run this task in a sandboxed project, where the agent runs with its permissions enabled.",
			},
		}
		return jsonLine(resp)
	}
	resp["response"] = map[string]any{
		"subtype":    "error",
		"request_id": id,
		"error":      "MIKE's agent host does not handle " + method,
	}
	return jsonLine(resp)
}

// Close cleans up adapter state.
func (a *Adapter) Close() {
	a.lineBuffer = ""
	a.pending = map[string]string{}
	a.current = newTurn()
}

// modelNameOrDefault returns the discovered model, or the binary's name when none was reported.
func (a *Adapter) modelNameOrDefault() string {
	if a.modelName != "" {
		return a.modelName
	}
	return a.config.Binary
}

// buildPersistEntries writes the turn as MIKE saves it: one assistant row per assembled message, then
// one row per tool call with its result. Cost is absent — the result's stats event reports it once.
func (a *Adapter) buildPersistEntries() []agent.PersistEntry {
	var entries []agent.PersistEntry
	for _, body := range a.current.assistants {
		model := defaultString(body.Model, a.modelNameOrDefault())
		usage := ccUsage{}
		if body.Usage != nil {
			usage = *body.Usage
		}
		text := bodyText(body)
		thinking := bodyThinking(body)
		uses := bodyToolUses(body)
		if text != "" || thinking != "" || len(uses) > 0 {
			entries = append(entries, agent.PersistEntry{
				Role:             "assistant",
				Content:          text,
				ReasoningContent: thinking,
				ModelName:        model,
				ProviderName:     a.config.DisplayName,
				PromptTokens:     int(usage.InputTokens),
				PredictedTokens:  int(usage.OutputTokens),
			})
		}

		for _, use := range uses {
			kanbanName := mapToolName(use.Name)
			rendered := use.Name
			if kanbanName != "" {
				rendered = kanbanName
			}
			args := mapToolArgs(use.Name, kanbanName, use.Input)
			argsJSON, _ := json.Marshal(args)
			toolCall, _ := json.Marshal(map[string]any{
				"tool_id":           use.ID,
				"tool_name":         rendered,
				"tool_display_name": toolDisplayName(use.Name),
				"args":              args,
				"raw_args":          string(argsJSON),
			})

			result := `{"output":"","success":true}`
			if r, ok := a.current.toolResults[use.ID]; ok {
				out, err := json.Marshal(map[string]any{"output": r.Output, "success": r.Success})
				if err == nil {
					result = string(out)
				}
			}
			entries = append(entries, agent.PersistEntry{
				Role:           "tool_call",
				ToolCallsJSON:  string(toolCall),
				ToolResultJSON: result,
			})
		}
	}

	// If no assembled message arrived, save what the reader saw streamed.
	if len(entries) == 0 && (a.current.streamedText != "" || a.current.streamedThinking != "") {
		entries = append(entries, agent.PersistEntry{
			Role:             "assistant",
			Content:          a.current.streamedText,
			ReasoningContent: a.current.streamedThinking,
			ModelName:        a.modelNameOrDefault(),
			ProviderName:     a.config.DisplayName,
		})
	}
	return entries
}
