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

Modify the request body. Order: `remove` -> `remove_if` -> `set`.

| Rule | Description |
| --- | --- |
| **`remove`** (List) | Delete specific paths (e.g., `"reasoning_effort"`). |
| **`remove_if`** (Map) | Delete a path if another path is missing. |
| **`set`** (Map) | Create or update a value at a path. |

**`set`** Rule Details: Use a string or a rule object:

- **Shorthand**: `"path": "value"` $\rightarrow$ sets the value directly.
- **Full Rule**:
  - `value`: The value to set:
    - a string: resolved at request time;
    - a number/bool: used as-is;
    - a map: picks a value by the `from` variable — keys are specific values, `"*"` is the fallback. A map without a `from` is skipped.
  - `when`: A list of allowed `from` values. The rule only runs if the variable matches one of these.
  - `from`: The variable to check (e.g., `"reasoning_effort"`). If empty, the first placeholder in a string `value` is used.

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

OpenRouter needs a nested `reasoning` object instead of a flat `reasoning_effort` field.

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

### Value Table Mapping (DeepSeek)

A two-state toggle that depends on the reasoning effort: `thinking.type` is `enabled` for all thinking efforts and `disabled` for `none`/`off` — a `value` table keyed on the effort, with a `*` fallback.

```json
{
  "match": "https://api.deepseek.com",
  "body": {
    "remove": ["thinking_budget_tokens", "reasoning_control", "chat_template_kwargs", "return_progress"],
    "set": {
      "thinking.type": {
        "from": "reasoning_effort",
        "value": {
          "none": "disabled",
          "off": "disabled",
          "*": "enabled"
        }
      }
    }
  }
}
```

The same pattern works for booleans (e.g. Qwen's `enable_thinking`: `"none": false, "off": false, "*": true`).

## Files

- `manifest.json`: Extension metadata and declaration of the `llm` capability.
- `mappings.json`: The actual provider adaptation rules.
