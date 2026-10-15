package claudecode

import "encoding/json"

// Claude Code stream-json wire shapes.
//
// Every struct is decoded from a line the CLI wrote, so every field is optional, the zero value is a
// legal answer, and only the fields this adapter reads are named.

// ccStreamEvent is one raw stream event forwarded whole by --include-partial-messages.
type ccStreamEvent struct {
	Event ccAPIEvent `json:"event"`
}

// ccAPIEvent is the part of a stream event this adapter reads; delta is meaningful only for
// content_block_delta.
type ccAPIEvent struct {
	Type  string  `json:"type"`
	Delta ccDelta `json:"delta"`
}

// ccDelta is one streamed piece of a content block.
type ccDelta struct {
	Type     string `json:"type"` // text_delta, thinking_delta, input_json_delta, signature_delta
	Text     string `json:"text"`
	Thinking string `json:"thinking"`
}

// ccMessage is an assembled conversation message: the model's turn, or a tool's output arriving back
// as a user turn.
type ccMessage struct {
	Message   ccBody `json:"message"`
	SessionID string `json:"session_id"`

	// ParentToolUseID is null on the main conversation and holds the id of the tool call that started
	// a sub-agent's message.
	ParentToolUseID *string `json:"parent_tool_use_id"`
}

// ccBody is the message body the CLI mirrors from the Anthropic API.
type ccBody struct {
	Model   string           `json:"model"`
	Content []ccContentBlock `json:"content"`
	Usage   *ccUsage         `json:"usage"`
}

// ccContentBlock is one content block; which fields are set depends on Type.
type ccContentBlock struct {
	Type string `json:"type"` // text, thinking, tool_use, tool_result

	Text     string `json:"text"`
	Thinking string `json:"thinking"`

	ID    string         `json:"id"` // tool_use: the id a later tool_result names
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`

	ToolUseID string          `json:"tool_use_id"` // tool_result: the tool_use this answers
	Content   json.RawMessage `json:"content"`     // tool_result payload: a string or a block array
	IsError   bool            `json:"is_error"`
}

// ccUsage is one message's token usage, in the Anthropic spellings.
type ccUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// contextTokens is what filled the model's window on this call: everything the model was sent.
func (u ccUsage) contextTokens() int {
	return int(u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens)
}

// ccSystem is a `system` message. The subtypes read here are init, compact_boundary, api_retry and
// permission_denied.
type ccSystem struct {
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	Model     string `json:"model"`

	// permission_denied
	ToolName       string `json:"tool_name"`
	Message        string `json:"message"`
	DecisionReason string `json:"decision_reason"`

	// api_retry
	Attempt       int    `json:"attempt"`
	MaxRetries    int    `json:"max_retries"`
	ErrorCategory string `json:"error"`

	// compact_boundary
	CompactMetadata struct {
		Trigger   string `json:"trigger"` // manual, auto
		PreTokens int64  `json:"pre_tokens"`
	} `json:"compact_metadata"`
}

// ccPermissionDenial is one action the permission mode refused during the turn.
type ccPermissionDenial struct {
	ToolName string `json:"tool_name"`
}

// ccResult closes a turn and is the turn's only source of cost.
type ccResult struct {
	Subtype      string                `json:"subtype"`
	IsError      bool                  `json:"is_error"`
	Result       string                `json:"result"`
	SessionID    string                `json:"session_id"`
	TotalCostUSD float64               `json:"total_cost_usd"`
	Usage        ccUsage               `json:"usage"`
	ModelUsage   map[string]ccModelUse `json:"modelUsage"`

	PermissionDenials []ccPermissionDenial `json:"permission_denials"`
}

// ccModelUse is the per-model roll-up a result carries. ContextWindow is what fills MIKE's context
// bar; with several models, the widest declared window wins.
type ccModelUse struct {
	ContextWindow int `json:"contextWindow"`
}

// ccControlRequest is a command from the CLI to the harness, such as a permission prompt.
type ccControlRequest struct {
	RequestID string `json:"request_id"`
	Request   struct {
		Subtype  string `json:"subtype"`
		ToolName string `json:"tool_name"`
	} `json:"request"`
}

// ccControlResponse is the CLI's answer to a control_request this adapter sent.
type ccControlResponse struct {
	Response struct {
		Subtype   string         `json:"subtype"` // "success" or "error"
		RequestID string         `json:"request_id"`
		Error     string         `json:"error"`
		Response  map[string]any `json:"response"`
	} `json:"response"`
}

// ccConfig is the resolved adapter configuration.
type ccConfig struct {
	Binary      string
	DisplayName string
	Env         []string
	SandboxEnvs []envVar // resolved env key-value pairs from manifest sandbox config
}

// envVar is one declared environment variable.
type envVar struct {
	Key   string
	Value string
}

// turn is what one CLI turn (prompt to result) contributed, kept so the turn persists whole at its end.
type turn struct {
	assistants  []ccBody // in the order they arrived
	toolResults map[string]ccToolResult

	// streamedText and streamedThinking hold what this turn's deltas carried.
	streamedText     string
	streamedThinking string
}

func newTurn() turn {
	return turn{toolResults: map[string]ccToolResult{}}
}

// ccToolResult is a tool's answer, joined to its call by the tool_use id.
type ccToolResult struct {
	Output  string
	Success bool
}
