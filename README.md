# Claude Custom Router

A lightweight, zero-dependency proxy that routes [Claude Code](https://docs.anthropic.com/en/docs/claude-code) API requests to different LLM providers based on model ID mapping and scenario detection.

## Why?

Claude Code sends all requests to a single Anthropic API endpoint. If you want to:

- **Route different model families** (Haiku/Sonnet/Opus) to different providers
- Route **image requests** to a vision-capable model
- **Load balance** across multiple providers to avoid rate limiting
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
  "upstreamTimeoutMs": 360000,
  "providers": {
    "default-provider": {
      "model": "actual-model-name",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${MY_API_KEY}",
      "maxTokens": 8192
    },
    "haiku-provider": {
      "model": "haiku-model-name",
      "baseURL": "https://api.haiku-provider.com/v1",
      "apiKey": "${HAIKU_API_KEY}"
    },
    "glm": {
      "model": "glm-4",
      "baseURL": "https://open.bigmodel.cn/api/anthropic",
      "apiKey": "${GLM_API_KEY}"
    },
    "qwen-sonnet": {
      "model": "qwen-plus",
      "baseURL": "https://dashscope.aliyuncs.com/apps/anthropic",
      "apiKey": "${QWEN_API_KEY}"
    },
    "opus-provider": {
      "model": "opus-model-name",
      "baseURL": "https://api.opus-provider.com/v1",
      "apiKey": "${OPUS_API_KEY}"
    },
    "vision-provider": {
      "model": "vision-model-name",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${API_KEY}"
    }
  },
  "pools": {
    "sonnet-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 5 },
        { "provider": "qwen-sonnet", "maxConns": 3 }
      ]
    }
  },
  "routes": {
    "default": { "provider": "default-provider" },
    "image": { "provider": "vision-provider" },
    "haiku": { "provider": "haiku-provider" },
    "sonnet": { "pool": "sonnet-primary" },
    "opus": { "provider": "opus-provider" }
  },
  "loadBalancer": {
    "showProvider": true
  }
}
```

### Configuration Layers

- `routes`: business-facing entrypoints such as `default`, `haiku`, `sonnet`, `opus`, `image`
- `pools`: named load-balancing pools that can be reused by multiple routes
- `providers`: concrete upstream endpoints plus the actual model name sent upstream

Each route must choose exactly one target:

- `{ "provider": "provider-id" }`
- `{ "pool": "pool-id" }`

## Load Balancing

When running Claude Code agent teams, multiple agents make concurrent LLM API calls that can overwhelm a single provider. Load balancing distributes requests across multiple providers based on **active connection counts**.

### Priority Fallback Strategy

The default strategy checks providers in configured order and selects the first one with available capacity (`activeConns < maxConns`). This is ideal when you have a primary provider and 1-2 backups — the primary handles most traffic, and backups only activate when the primary is saturated.

### Capacity Unit

Load balancing capacity is keyed by the `providerId`, which is the same ID used in `pools.<pool>.providers[*].provider`.

- Reusing the same `providerId` across multiple pools shares one connection pool. For example, if both `haiku-primary` and `sonnet-primary` reference `glm`, they share the same `activeConns` budget.
- Using different `providerId`s keeps capacity isolated, even if those providers point to the same upstream model name. For example, `glm` and `zai_glm` are tracked separately even if both use `"model": "glm-4"`.
- Capacity is not keyed by route name and is not merged automatically by `providers[*].model`.

### Configuration

```json
{
  "providers": {
    "glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." },
    "haiku-provider": { "model": "haiku-model", "baseURL": "...", "apiKey": "..." },
    "deepseek-sonnet": { "model": "deepseek-chat", "baseURL": "...", "apiKey": "..." },
    "qwen-sonnet": { "model": "qwen-plus", "baseURL": "...", "apiKey": "..." }
  },
  "pools": {
    "haiku-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 3 },
        { "provider": "haiku-provider", "maxConns": 5 }
      ]
    },
    "sonnet-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 3 },
        { "provider": "deepseek-sonnet", "maxConns": 5 },
        { "provider": "qwen-sonnet", "maxConns": 3 }
      ]
    }
  },
  "routes": {
    "haiku": { "pool": "haiku-primary" },
    "sonnet": { "pool": "sonnet-primary" }
  },
  "loadBalancer": {
    "showProvider": true
  }
}
```

If you want the same upstream family to use separate capacity pools, give them different provider IDs:

```json
{
  "providers": {
    "glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." },
    "zai_glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." }
  }
}
```

### How it works

1. A detector resolves a route key such as `haiku` or `sonnet`
2. The router reads `routes.<key>` and chooses either a direct provider or a named pool
3. If the route points to a pool, the pool selects the first provider where `activeConns < maxConns`
4. If all providers in a pool are at capacity, it **fail-opens** to the first provider (no request dropped)
5. `activeConns` is tracked by provider ID, so reusing the same provider ID in multiple pools shares the same live count
6. Connection cleanup uses an **once-guard** to prevent double-decrement

### Visibility

When `loadBalancer.showProvider` is `true`:
- **Response header**: `X-Router-Provider: deepseek-sonnet`
- **SSE comment**: `: router_provider: deepseek-sonnet` (in streaming responses)
- **Request logs**: `[a3k9f2][abc123] claude-sonnet-4-5 -> deepseek-chat [route=sonnet pool=sonnet-primary provider=deepseek-sonnet 2/5 active]`
- **Health endpoint**: `/health` includes `routes` plus `loadBalancer.pools`. If multiple pools reuse the same provider ID, that shared `activeConns` value can appear in more than one pool view.

### Config Validation

The proxy validates LB config at startup and on hot-reload:
- Every route must reference an existing provider or pool
- Every pool provider must reference an existing provider config
- Provider IDs must be unique within a pool
- The same provider ID may appear in multiple pools when you want them to share one capacity pool
- `maxConns` must be positive integers
- Strategy must be known (`priority-fallback`)
- Provider IDs cannot collide with route or pool keys
- Pool IDs cannot collide with route keys

### Provider Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `model` | No | Actual model name sent to provider (defaults to provider ID) |
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

### Route Keys

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
1. **Direct lookup**: `body.model` as a key in `providers` config
2. **Default fallback**: `routes.default`

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
      if (!ctx.config.routes.coding) return null;
      const hasCodeTools = (body.tools || []).some(t =>
        t.name === 'Read' || t.name === 'Edit'
      );
      // Return route KEY, not provider ID
      return hasCodeTools ? 'coding' : null;
    },
  },
];
```

Then add the router rule:

```json
{
  "routes": {
    "coding": { "provider": "my-coding-provider" }
  }
}
```

> **Note**: Custom detectors should return the **route key** (e.g., `'coding'`), not the provider ID. The proxy resolves the route to either a direct provider or a named pool. Returning provider IDs directly still works via direct lookup, but returning the route key is the recommended approach.

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
| `/health` | GET | Health check (returns providers, routes, pool status, debug status) |
| `/v1/models` | GET | List configured providers in Anthropic model-list format |
| `/v1/messages` | POST | Proxy endpoint (routes to appropriate model) |
| Other paths | Any | Forwarded to default model's base URL |

## Hot Reload

The proxy watches `~/.claude-custom-router.json` for changes and reloads automatically. No restart needed.

## Debug Mode

Set `"debug": true` in config to enable request/response dumps:

```
~/.claude-custom-router.d/logs/debug/
  └── <session-id>/
      ├── <timestamp>_<reqid>_<model>_req.json       # Original request
      ├── <timestamp>_<reqid>_<model>_processed.json # Routed request
      └── <timestamp>_<reqid>_<model>_res.txt        # Response
```

- Request log prefixes include the generated request ID and the first 6 characters of `session_id` when available: `[reqid][session6]`.
- Debug dumps are grouped by `session_id`; when no session is present, the proxy falls back to today's date (`YYYYMMDD`).
- Upstream non-2xx responses are logged with their decoded response body (truncated for very large bodies).

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
