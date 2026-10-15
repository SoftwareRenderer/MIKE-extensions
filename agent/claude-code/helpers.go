package claudecode

import (
	"encoding/json"
	"strings"

	"mike/pkg/agent"
)

// fromSubagent reports a message from a sub-agent's run rather than this conversation. Its tool calls
// are joined by tool_use_id, so accepting them would show another run's work as this turn's.
func fromSubagent(msg ccMessage) bool {
	return msg.ParentToolUseID != nil && *msg.ParentToolUseID != ""
}

// defaultString returns v, or d when v is empty.
func defaultString(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// blockText joins a content payload that is either a bare string or an array of blocks; the CLI writes
// a tool's output both ways.
func blockText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []ccContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	// Neither shape: keep the bytes the CLI sent rather than dropping them.
	return string(raw)
}

// bodyText joins the text blocks of an assembled message.
func bodyText(b ccBody) string {
	var parts []string
	for _, c := range b.Content {
		if c.Type == "text" && c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// bodyThinking joins a message's thinking blocks into one reasoning record.
func bodyThinking(b ccBody) string {
	var parts []string
	for _, c := range b.Content {
		if c.Type == "thinking" && c.Thinking != "" {
			parts = append(parts, c.Thinking)
		}
	}
	return strings.Join(parts, "\n")
}

// bodyToolUses lists a message's tool_use blocks in call order.
func bodyToolUses(b ccBody) []ccContentBlock {
	var uses []ccContentBlock
	for _, c := range b.Content {
		if c.Type == "tool_use" {
			uses = append(uses, c)
		}
	}
	return uses
}

// bodyToolResults lists a message's tool_result blocks, which arrive on a user message.
func bodyToolResults(b ccBody) []ccContentBlock {
	var results []ccContentBlock
	for _, c := range b.Content {
		if c.Type == "tool_result" {
			results = append(results, c)
		}
	}
	return results
}

// controlRequest is one command from the harness to the CLI. request_id is ours and the CLI echoes it
// back, which is what ties an answer to the command it answers.
func controlRequest(id, subtype string, fields map[string]any) map[string]any {
	req := map[string]any{"subtype": subtype}
	for k, v := range fields {
		req[k] = v
	}
	return map[string]any{
		"type":       "control_request",
		"request_id": id,
		"request":    req,
	}
}

// firstString returns the first key in data that holds a non-empty string.
func firstString(data map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := data[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// modelFromResponse reads a model name out of a control_response payload, whose shape is the CLI's to
// change; with neither spelling present, the caller keeps the name it had.
func modelFromResponse(data map[string]any) string {
	if name := firstString(data, "model", "model_name", "modelId"); name != "" {
		return name
	}
	if m, ok := data["model"].(map[string]any); ok {
		return firstString(m, "id", "name")
	}
	return ""
}

// largestContextWindow is the widest window any model used this turn declared. Zero means none was
// declared, and MIKE's context bar stays empty.
func largestContextWindow(usage map[string]ccModelUse) int {
	win := 0
	for _, u := range usage {
		if u.ContextWindow > win {
			win = u.ContextWindow
		}
	}
	return win
}

// sessionStats reports the last measured totals and the context they filled. Cost is the caller's to
// set: the runner adds a per-turn cost and overwrites a session total.
func sessionStats(u ccUsage, contextWindow int) agent.SessionStatsData {
	s := agent.SessionStatsData{
		TotalInput:      int(u.InputTokens),
		TotalOutput:     int(u.OutputTokens),
		TotalCacheRead:  int(u.CacheReadInputTokens),
		TotalCacheWrite: int(u.CacheCreationInputTokens),
		ContextTokens:   u.contextTokens() + int(u.OutputTokens),
		ContextWindow:   contextWindow,
	}
	if s.ContextWindow > 0 && s.ContextTokens > 0 {
		s.ContextPercent = float64(s.ContextTokens) / float64(s.ContextWindow) * 100
	}
	return s
}
