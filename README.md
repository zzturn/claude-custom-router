# Claude Custom Router

A lightweight, zero-dependency proxy that routes [Claude Code](https://docs.anthropic.com/en/docs/claude-code) API requests to different LLM providers based on model ID mapping and scenario detection.

## Why?

Claude Code sends all requests to a single Anthropic API endpoint. If you want to:

- **Route different model families** (Haiku/Sonnet/Opus) to different providers
- Route **image requests** to a vision-capable model
- Use a **default provider** as fallback

...you'd need to manually switch models or maintain separate configurations. This proxy automates it.

## How It Works

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Claude Code  │────▶│  Custom Model Proxy   │────▶│  Claude API     │
│              │     │                      │     ├─────────────────┤
│              │     │  Routing:            │     │  GLM / DeepSeek │
│              │     │  • Explicit override  │     │  Qwen / Others  │
│              │     │  • Image detection    │     │  ...            │
│              │     │  • Model ID mapping   │     └─────────────────┘
│              │     │    (haiku/sonnet/opus)│
│              │     │                      │◀── Custom scenarios
│              │     └──────────────────────┘    (extensible)
└─────────────┘
```

Each request goes through a chain of **detectors** (sorted by priority). The first match determines which model handles the request.

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
    "default": "my-default-model",
    "image": "vision-model",
    "haiku": "haiku-provider",
    "sonnet": "sonnet-provider",
    "opus": "opus-provider"
  },
  "models": {
    "my-default-model": {
      "name": "actual-model-name",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${MY_API_KEY}",
      "maxTokens": 8192
    },
    "haiku-provider": {
      "name": "haiku-model-name",
      "baseURL": "https://api.haiku-provider.com/v1",
      "apiKey": "${HAIKU_API_KEY}"
    },
    "sonnet-provider": {
      "name": "sonnet-model-name",
      "baseURL": "https://api.sonnet-provider.com/v1",
      "apiKey": "${SONNET_API_KEY}"
    },
    "opus-provider": {
      "name": "opus-model-name",
      "baseURL": "https://api.opus-provider.com/v1",
      "apiKey": "${OPUS_API_KEY}"
    },
    "vision-model": {
      "name": "vision-model-name",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${API_KEY}"
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

| Rule | Key | Description |
|------|-----|-------------|
| Default | `default` | Fallback when no detector matches |
| Image | `image` | Routes requests containing image content |
| Haiku | `haiku` | Routes when model ID contains "haiku" |
| Sonnet | `sonnet` | Routes when model ID contains "sonnet" |
| Opus | `opus` | Routes when model ID contains "opus" |

## Scenario Detectors

Built-in detectors run in priority order (lower = higher priority):

| Priority | Detector | Trigger |
|----------|----------|---------|
| 0 | **explicit** | Comma-separated model ID in request (`model: "original,custom-model"`) |
| 5 | **image** | Image or image_url content in recent messages |
| 8 | **modelFamily** | Model ID contains haiku/sonnet/opus keyword |

After all detectors, the router tries:
1. **Direct lookup**: `body.model` as a key in `models` config
2. **Default fallback**: `Router.default`

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
