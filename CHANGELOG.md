# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
