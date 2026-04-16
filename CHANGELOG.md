# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2025-04-16

### Added

- **Load Balancing**: Distribute requests across multiple providers to avoid rate limiting
  - `priority-fallback` strategy: check providers in order, select first with available capacity
  - Active connection tracking via stream lifecycle events (`close` / `error`)
  - Once-guard prevents double-decrement on connection cleanup
  - Fail-open behavior: uses first provider when all at capacity
  - Extensible strategy pattern for future strategies (round-robin, weighted, etc.)
- **Visibility**: Know which provider handled each request
  - `X-Router-Provider` response header
  - SSE comment injection (`: router_provider: <id>`) for streaming responses
  - `[ROUTE]` log entries with active connection counts
  - `/health` endpoint includes LB group status
  - Configurable via `LoadBalancer.showProvider`
- **Config validation**: Strict validation for LB groups on startup and hot-reload
  - Provider IDs must exist in models config
  - No duplicate providers within a group
  - `maxConns` must be positive integers
  - Strategy must be recognized
  - Model config IDs cannot collide with Router keys

### Changed

- **Detector contract change**: Built-in detectors now return Router **keys** (e.g., `"sonnet"`) instead of Router **values** (e.g., `"sonnet-model"`)
  - `detectModelFamily()` returns `"sonnet"` / `"haiku"` / `"opus"` instead of the mapped provider
  - `detectImage()` returns `"image"` instead of the mapped vision provider
  - `resolveModel()` default fallback returns `"default"` instead of the mapped default
  - Disambiguation handled by new `resolveRouterEntry()` in `routeAndForward()`
- Custom detectors returning model config IDs still work via fallback, but returning Router keys is recommended

## [2.0.0] - 2025-04-15

### Changed

- **Breaking**: Replaced scenario detectors with model family mapping
  - Removed: longContext, subagent, background, webSearch, think detectors
  - Added: `modelFamily` detector — maps Claude model IDs (haiku/sonnet/opus) to Router config
  - Image detection remains with higher priority than model family mapping
- Config format: `Router.haiku`, `Router.sonnet`, `Router.opus` replace old scenario keys
  - Removed: `longContext`, `longContextThreshold`, `subagent`, `background`, `webSearch`, `think`

### Migration

Update `~/.claude-custom-router.json`:

```json
// Old format
{
  "Router": {
    "default": "...",
    "longContext": "...",
    "background": "...",
    "think": "...",
    "webSearch": "..."
  }
}

// New format
{
  "Router": {
    "default": "...",
    "image": "...",
    "haiku": "...",
    "sonnet": "...",
    "opus": "..."
  }
}
```

## [1.0.0] - 2025-04-15

### Added

- Scenario-based request routing with 7 built-in detectors
  - Explicit model override via comma-separated IDs
  - Image/vision content detection
  - Long context routing with configurable threshold
  - Subagent model tags (`<CCR-SUBAGENT-MODEL>`)
  - Background task routing (Haiku model detection)
  - Web search tool detection
  - Extended thinking detection
- Custom scenario detector support via `custom-scenarios.mjs`
- Hot-reload configuration (watches `custom-models.json`)
- Environment variable resolution in config (`${VAR}` / `$VAR` syntax)
- Health check endpoint (`GET /health`)
- Model listing endpoint (`GET /v1/models`)
- Debug mode with request/response dumps
- `max_tokens` capping per model
- PID file management for process control
- CLI commands: `--start`, `--stop`, `--status`
- Configurable base directory via `ROUTER_CONFIG_DIR` env var
- Beijing time (UTC+8) logging
- Token estimation from request body
- Zero npm dependencies
