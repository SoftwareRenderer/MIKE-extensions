# API Compatibility

The **API Compatibility** extension allows MIKE to adapt its standard OpenAI-compatible LLM requests to the specific requirements of different providers.

While many providers claim OpenAI compatibility, they often differ in required headers or the structure of the request body (e.g., using `reasoning_effort: "high" `instead of `reasoning: { effort: "high" }` ). This extension provides a declarative way to handle these differences without changing the core backend code and enabling more seamless and rapid updates.

## Installation

1. Navigate to **Settings → Extensions**.
2. Find **API Compatibility** under local extensions and click **Install**.
3. This extension is active as long as its directory exists in the server's `extensions/` directory and is enabled.

## Configuration

Mappings are defined in **`mappings.json`**. Edit this file and disable/enable the extension to apply changes.

### Template Variables

The following placeholders can be used in header values and `set` rule values. They are resolved at request time:

| Variable | Description |
| --- | --- |
| `{{model}}` | The name of the model being called. |
| `{{reasoning_effort}}` | The configured reasoning effort (e.g., `low`, `medium`, `high`, `none`, `off`, `default`, or empty). |

### Mapping Structure

Each mapping in the `mappings.json` array consists of:

#### 1. `match` (String)

The provider base-URL prefix to match.

- Trailing slashes are ignored.
- The character after the prefix must be `/` or the end of the URL (e.g., `https://openrouter` will NOT match `https://openrouter.ai`).
- **First-match-wins**: The first mapping that matches the URL is the only one applied.

#### 2. `headers` (Map)

A set of headers to add to the request.

- Values are template-resolved.
- If a resolved value still contains an unresolved `{{placeholder}}`, the header is skipped.

#### 3. `body` (Object)

Transformations applied to the JSON request body. They are executed in this specific order: `remove` -> `remove_if` -> `set`.

| Rule | Description |
| --- | --- |
| **`remove`** (Array of Strings) | List of dot-separated JSON paths to delete unconditionally (e.g., `"reasoning_effort"`). |
| **`remove_if`** (Map) | `{"key": "otherKey"}` deletes `key` only if `otherKey` is absent from the body. (Example: remove `tool_choice` if no `tools` are present). |
| **`set`** (Map) | Creates or overwrites a value at a dot-separated JSON path. Parent objects are created automatically. |

**`set`**** Rule Details:** A `set` entry can be a plain string (shorthand) or a full rule object:

- **Shorthand**: `"path": "value"` -> treated as `{ "value": "value" }`.
- **Full Rule**:
- `value`: The value to set. If it's a string, it's template-resolved. Other types (number, bool, object, array) are set verbatim.
- `when`: (Optional) An array of values. The rule is only applied if the "gate variable" matches one of these values.
- `from`: (Optional) Specifies the template variable to use as the gate for `when`. If omitted, the first placeholder found in `value` is used.

## Examples

### Basic Static Mapping

Adds a custom header and removes a field that a specific provider doesn't support.

```json
{
  "match": "https://my-provider.com/v1",
  "headers": {
    "X-Custom-Header": "MIKE-App"
  },
  "body": {
    "remove": ["unsupported_field"]
  }
}
```

### Advanced Conditional Mapping (OpenRouter)

OpenRouter requires specific headers and a nested `reasoning` object instead of a flat `reasoning_effort` field.

```json
{
  "match": "https://openrouter.ai",
  "headers": {
    "HTTP-Referer": "https://getmike.dev",
    "X-OpenRouter-Title": "MIKE: Integrated Kanban Env."
  },
  "body": {
    "remove": ["thinking_budget_tokens", "reasoning_effort"],
    "remove_if": {
      "tool_choice": "tools"
    },
    "set": {
      "reasoning.effort": {
        "value": "{{reasoning_effort}}",
        "when": ["low", "medium", "high"]
      },
      "reasoning.enabled": {
        "from": "reasoning_effort",
        "value": true,
        "when": ["", "default"]
      }
    }
  }
}
```

## Files

- `manifest.json`: Extension metadata and declaration of the `llm` capability.
- `mappings.json`: The actual provider adaptation rules.
