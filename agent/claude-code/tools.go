package claudecode

import (
	"strings"
	"unicode"
)

// Tool rendering: Claude Code's tools are its own, and MIKE's chat renders a card per *MIKE* tool name
// with a fixed set of argument keys, so mapToolName renames a tool MIKE has a card for and mapToolArgs
// reshapes its arguments into the keys that card reads. A tool with no MIKE equivalent keeps its own
// name and arguments and only gets a display name.

type toolMap struct {
	claudeName  string
	kanbanName  string
	displayName string
}

var toolMaps = []toolMap{
	{"Read", "read_file", "Read File"},
	{"Write", "write_file", "Write File"},
	{"Edit", "edit_file", "Edit File"},
	{"NotebookEdit", "edit_file", "Edit File"},
	{"Bash", "bash", "Bash"},
	{"Glob", "", "Find Files"},
	{"Grep", "", "Search"},
	{"Agent", "", "Subagent"},
	{"Skill", "", "Run Skill"},
	{"AskUserQuestion", "", "Ask Question"},
	{"TodoWrite", "", "Plan Steps"},
	{"TaskCreate", "", "Add Plan Step"},
	{"TaskUpdate", "", "Update Plan Step"},
	{"TaskList", "", "List Plan Steps"},
	{"TaskGet", "", "Read Plan Step"},
	{"TaskOutput", "", "Background Output"},
	{"LSP", "", "Language Server"},
	{"Monitor", "", "Watch Output"},
	{"WebFetch", "", "Fetch Page"},
	{"WebSearch", "", "Search Web"},
	{"ExitPlanMode", "", "Exit Plan Mode"},
}

// allowedTools is what the run is granted, as the one comma-separated value the CLI takes. The table
// above names a tool for display and this one grants it, so the sets differ; AskUserQuestion goes
// ungranted because dontAsk denies it whatever it is granted.
var allowedTools = []string{
	"Read", "Write", "Edit", "NotebookEdit",
	"Glob", "Grep", "Bash", "Monitor",
	"LSP", "Agent", "Skill",
	"TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
	"WebFetch", "WebSearch", "ToolSearch",
}

func allowedToolsArg() string { return strings.Join(allowedTools, ",") }

var toolIndex = func() map[string]toolMap {
	m := make(map[string]toolMap, len(toolMaps))
	for _, t := range toolMaps {
		m[t.claudeName] = t
	}
	return m
}()

// mapToolName returns the MIKE tool a Claude Code tool renders as, or "" when it has no equivalent.
func mapToolName(claudeName string) string {
	if t, ok := toolIndex[claudeName]; ok {
		return t.kanbanName
	}
	return ""
}

// toolDisplayName names a tool call in the chat. An unmapped tool is titled from its own PascalCase
// name.
func toolDisplayName(claudeName string) string {
	if t, ok := toolIndex[claudeName]; ok && t.displayName != "" {
		return t.displayName
	}
	return titleCaseWords(claudeName)
}

// titleCaseWords splits a camelCase name into spaced words, keeping each word's capitalisation.
func titleCaseWords(s string) string {
	runes := []rune(s)
	var b strings.Builder
	for i, r := range runes {
		if unicode.IsUpper(r) && i > 0 {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// mapToolArgs rewrites a tool's arguments into the shape MIKE's card for `kanbanName` renders. An
// unmapped tool's arguments pass through untouched.
func mapToolArgs(claudeName, kanbanName string, input map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	switch kanbanName {
	case "read_file":
		return keep(input, map[string]string{"file_path": "path", "offset": "offset", "limit": "limit"})
	case "write_file":
		return keep(input, map[string]string{"file_path": "path", "content": "content"})
	case "edit_file":
		return editFileArgs(claudeName, input)
	case "bash":
		return keep(input, map[string]string{"command": "command", "description": "description"})
	default:
		return input
	}
}

// keep copies the named keys out of src, renaming as it goes. A key the tool did not set stays absent.
func keep(src map[string]any, keys map[string]string) map[string]any {
	out := map[string]any{}
	for srcKey, dstKey := range keys {
		if v, ok := src[srcKey]; ok && v != nil {
			if s, isStr := v.(string); isStr && s == "" {
				continue
			}
			out[dstKey] = v
		}
	}
	return out
}

// editFileArgs builds MIKE's `edits` array from whichever edit shape this tool used. The card renders
// each pair as a diff, so `old_string`/`new_string` arrives as `oldText`/`newText`.
func editFileArgs(claudeName string, input map[string]any) map[string]any {
	out := map[string]any{}
	// The file arrives under the tool's own noun: file_path, or notebook_path for NotebookEdit.
	for _, key := range []string{"file_path", "notebook_path"} {
		if p, ok := input[key].(string); ok && p != "" {
			out["path"] = p
			break
		}
	}

	var edits []any
	switch claudeName {
	case "NotebookEdit":
		// A cell replacement has no "before" to show, so it renders as a pure insertion.
		if src, ok := input["new_source"].(string); ok {
			edits = append(edits, editPair(map[string]any{"old": "", "new": src}, "old", "new"))
		}
	default: // Edit
		if e := editPair(input, "old_string", "new_string"); e != nil {
			edits = append(edits, e)
		}
	}
	if len(edits) > 0 {
		out["edits"] = edits
	}
	return out
}

// editPair reads one old/new pair under the given keys; one side present is enough.
func editPair(src map[string]any, oldKey, newKey string) map[string]any {
	oldText, oldOK := src[oldKey].(string)
	newText, newOK := src[newKey].(string)
	if !oldOK && !newOK {
		return nil
	}
	return map[string]any{"oldText": oldText, "newText": newText}
}
