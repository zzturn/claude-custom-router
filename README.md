# Claude Custom Router

A lightweight, zero-dependency proxy that routes [Claude Code](https://docs.anthropic.com/en/docs/claude-code) API requests to different LLM providers based on scenario detection.

## Why?

Claude Code sends all requests to a single Anthropic API endpoint. If you want to:

- Use **cheaper models** for background tasks while keeping Claude for complex work
- Route **image requests** to a vision-capable model
- Handle **long contexts** with a model that has a larger window
- Use **extended thinking** with a reasoning-specialized model

...you'd need to manually switch models or maintain separate configurations. This proxy automates it.

## How It Works

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Claude Code  │────▶│  Custom Model Proxy   │────▶│  Claude API     │
│              │     │                      │     ├─────────────────┤
│              │     │  Scenario Detection: │     │  GLM / DeepSeek │
│              │     │  • Explicit override  │     │  Qwen / Others  │
│              │     │  • Image detection    │     │  ...            │
│              │     │  • Long context       │     └─────────────────┘
│              │     │  • Subagent tags      │
│              │     │  • Background tasks   │◀── Custom scenarios
│              │     │  • Web search tools   │    (extensible)
│              │     │  • Extended thinking  │
│              │     └──────────────────────┘
└─────────────┘
```

Each request goes through a chain of **scenario detectors** (sorted by priority). The first match determines which model handles the request.

## Quick Start

### 1. Install

```bash
git clone https://github.com/your-username/claude-custom-router.git
cd claude-custom-router
```

### 2. Configure

```bash
# Copy the example config and edit it
cp config/custom-models.example.json ~/.claude-custom-router.json

# Edit with your API keys and model endpoints
vim ~/.claude-custom-router.json
```

### 3. Run

```bash
# Start the proxy
node src/custom-model-proxy.mjs

# Configure Claude Code to use it
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
export ANTHROPIC_API_KEY="your-key-here"
```

### 4. Verify

```bash
curl http://127.0.0.1:8082/health
```

## Configuration

Config file: `~/.claude-custom-router.json` (or `$ROUTER_CONFIG_PATH`)

```json
{
  "port": 8082,
  "debug": false,
  "Router": {
    "default": "my-main-model",
    "longContext": "model-with-large-context",
    "longContextThreshold": 60000,
    "image": "vision-model",
    "background": "fast-cheap-model",
    "think": "reasoning-model",
    "webSearch": "search-capable-model"
  },
  "models": {
    "my-main-model": {
      "name": "actual-model-name",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${MY_API_KEY}",
      "maxTokens": 8192
    }
  }
}
```

### Model Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Actual model name sent to provider (defaults to model ID) |
| `baseURL` | Yes | Provider API base URL |
| `apiKey` | Yes | API key (supports `${ENV_VAR}` syntax) |
| `maxTokens` | No | Cap for `max_tokens` in requests |

### Environment Variables in Config

Use `${ENV_VAR}` or `$ENV_VAR` syntax to reference environment variables:

```json
{
  "apiKey": "${MY_PROVIDER_API_KEY}",
  "baseURL": "$PROVIDER_BASE_URL"
}
```

### Router Rules

| Scenario | Key | Description |
|----------|-----|-------------|
| Default | `default` | Fallback when no detector matches |
| Long Context | `longContext` + `longContextThreshold` | Routes when estimated tokens exceed threshold |
| Image | `image` | Routes requests containing image content |
| Background | `background` | Routes Haiku model requests (lightweight tasks) |
| Extended Thinking | `think` | Routes requests with `thinking` parameter |
| Web Search | `webSearch` | Routes requests with `web_search` tools |

## Scenario Detectors

Built-in detectors run in priority order (lower = higher priority):

| Priority | Detector | Trigger |
|----------|----------|---------|
| 0 | **explicit** | Comma-separated model ID in request (`model: "original,custom-model"`) |
| 5 | **image** | Image or image_url content in recent messages |
| 10 | **longContext** | Estimated tokens > threshold (default: 60k) |
| 20 | **subagent** | `<CCR-SUBAGENT-MODEL>` tag in system prompt |
| 30 | **background** | Haiku model detected in request |
| 40 | **webSearch** | `web_search` tool type present |
| 50 | **think** | `thinking` parameter present |

### Subagent Model Override

Embed a model tag in your subagent's system prompt to route it to a specific model:

```
<CCR-SUBAGENT-MODEL>my-custom-model</CCR-SUBAGENT-MODEL>You are a helpful assistant...
```

The proxy strips the tag and routes to the specified model.

## Custom Scenarios

Create `~/.claude-custom-scenarios.mjs` (or set `$ROUTER_SCENARIOS_PATH`) to add your own detectors:

```javascript
export const detectors = [
  {
    name: 'coding',
    priority: 15,
    detect(body, ctx) {
      // body: Anthropic API request body
      // ctx: { tokenCount, config }
      if (!ctx.config.Router.coding) return null;
      const hasCodeTools = (body.tools || []).some(t =>
        t.name === 'Read' || t.name === 'Edit'
      );
      return hasCodeTools ? ctx.config.Router.coding : null;
    },
  },
];
```

Then add the router rule:

```json
{
  "Router": {
    "coding": "my-coding-model"
  }
}
```

See [`examples/custom-scenarios.mjs`](examples/custom-scenarios.mjs) for more examples.

## CLI Commands

```bash
# Start proxy (foreground)
node src/custom-model-proxy.mjs

# Stop running proxy
node src/custom-model-proxy.mjs --stop

# Check status
node src/custom-model-proxy.mjs --status
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_CONFIG_PATH` | `~/.claude-custom-router.json` | Path to config file |
| `ROUTER_SCENARIOS_PATH` | `~/.claude-custom-scenarios.mjs` | Path to custom scenarios module |
| `ROUTER_PORT` | From config (8082) | Override proxy port |
| `ROUTER_LOG_DIR` | `~/.claude-custom-router.d/logs` | Directory for log files |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns models, router config, debug status) |
| `/v1/models` | GET | List configured models (Anthropic API format) |
| `/v1/messages` | POST | Proxy endpoint (routes to appropriate model) |
| Other paths | Any | Forwarded to default model's base URL |

## Hot Reload

The proxy watches `~/.claude-custom-router.json` for changes and reloads automatically. No restart needed.

## Debug Mode

Set `"debug": true` in config to enable request/response dumps:

```
~/.claude-custom-router.d/logs/debug/
  └── <session-id>/
      ├── <timestamp>_<random>_<model>_req.json      # Original request
      ├── <timestamp>_<random>_<model>_processed.json # Routed request
      └── <timestamp>_<random>_<model>_res.txt        # Response
```

## Integration with Claude Code

Add to your shell profile (`.zshrc` / `.bashrc`):

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
```

Or use it per-session:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:8082" claude
```

## Running Tests

```bash
npm test
```

Uses Node.js built-in test runner — zero dependencies.

## Requirements

- Node.js >= 18.0.0
- No npm dependencies

## License

MIT
