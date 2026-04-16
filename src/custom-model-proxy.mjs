#!/usr/bin/env node
/**
 * Custom Model Proxy for Claude Code
 *
 * A lightweight proxy that routes Claude Code API requests to different
 * LLM providers based on scenario detection and model configuration.
 *
 * Anthropic API spec only - no format transformation needed.
 *
 * Config: ~/.claude-custom-router.json (or $ROUTER_CONFIG_PATH)
 * Custom scenarios: ~/.claude-custom-scenarios.mjs (or $ROUTER_SCENARIOS_PATH)
 *
 * Usage:
 *   node custom-model-proxy.mjs          # Start proxy
 *   node custom-model-proxy.mjs --stop   # Stop proxy
 *   node custom-model-proxy.mjs --status # Check status
 *
 * Environment Variables:
 *   ROUTER_CONFIG_PATH     - Path to config file (default: ~/.claude-custom-router.json)
 *   ROUTER_SCENARIOS_PATH  - Path to custom scenarios module
 *   ROUTER_PORT            - Override port from config (default: 8082)
 *   ROUTER_LOG_DIR         - Directory for logs (default: ~/.claude-custom-router.d)
 */

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  readFileSync, writeFileSync, writeFile, unlinkSync, existsSync,
  watchFile, unwatchFile, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { Transform } from 'node:stream';

import {
  strategies, activeConns, lbState,
  incConn, decConn, getConns,
  selectProvider, withConnTracking,
} from './load-balancer.mjs';
import {
  MODEL_FAMILIES, detectExplicitModel, detectModelFamily, detectImage,
} from './detectors.mjs';
import { homedir } from 'node:os';

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();

/** @type {string} Path to model configuration file */
const CONFIG_PATH = process.env.ROUTER_CONFIG_PATH || join(HOME, '.claude-custom-router.json');

/** @type {string} Path to PID file for process management */
const DATA_DIR = join(HOME, '.claude-custom-router.d');

/** @type {string} Path to PID file */
const PID_PATH = join(DATA_DIR, 'proxy.pid');

/** @type {string} Directory for log files */
const LOG_DIR = process.env.ROUTER_LOG_DIR || join(DATA_DIR, 'logs');

/** @type {string} Path to main log file */
const LOG_PATH = join(LOG_DIR, 'custom-model-proxy.log');

/** @type {string} Path to custom scenarios module */
const CUSTOM_SCENARIOS_PATH = process.env.ROUTER_SCENARIOS_PATH || join(HOME, '.claude-custom-scenarios.mjs');

/** @type {string} Directory for debug dumps */
const DEBUG_DIR = join(LOG_DIR, 'debug');

/** @type {number} Default proxy port */
const DEFAULT_PORT = 8082;

/** @type {number} Approximate characters per token for estimation */
const TOKEN_CHAR_RATIO = 4;

// ─── CLI Commands ─────────────────────────────────────────────────────────────

if (process.argv.includes('--stop')) {
  if (existsSync(PID_PATH)) {
    const raw = readFileSync(PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) { console.log(`Invalid PID file: ${raw}`); process.exit(1); }
    try { process.kill(pid, 'SIGTERM'); console.log(`Stopped proxy (PID ${pid})`); }
    catch { console.log(`Process ${pid} not running, cleaning up`); }
    try { unlinkSync(PID_PATH); } catch (e) { console.error('PID cleanup failed:', e.message); }
  } else { console.log('Proxy not running'); }
  process.exit(0);
}

if (process.argv.includes('--status')) {
  if (existsSync(PID_PATH)) {
    const raw = readFileSync(PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) { console.log(`Invalid PID file: ${raw}`); process.exit(1); }
    try { process.kill(pid, 0); console.log(`Proxy running (PID ${pid})`); }
    catch { console.log(`Proxy not running (stale PID: ${pid})`); }
  } else { console.log('Proxy not running'); }
  process.exit(0);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

/**
 * Returns current timestamp in local timezone formatted as YYYY-MM-DD HH:mm:ss
 * @returns {string}
 */
function nowLocal() {
  return new Date().toLocaleString('sv-SE', { hour12: false });
}

/**
 * Appends a timestamped log line to both console and log file
 * @param {string} level - Log level (INFO, ROUTE, WARN, ERROR, DEBUG)
 * @param {string} msg - Log message
 */
function log(level, msg) {
  const line = `[${nowLocal()}] [${level}] ${msg}`;
  console.log(line);
  try { writeFile(LOG_PATH, line + '\n', { flag: 'a' }, (e) => { if (e) console.error('Log write failed:', e.message); }); } catch (e) { console.error('Log write failed:', e.message); }
}

/** @type {{ info: (msg: string) => void, route: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void, debug: (msg: string) => void }} */
const L = {
  info:  (msg) => log('INFO',  msg),
  route: (msg) => log('ROUTE', msg),
  warn:  (msg) => log('WARN',  msg),
  error: (msg) => log('ERROR', msg),
  debug: (msg) => { if (config.debug) log('DEBUG', msg); },
};

// ─── Config Management ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ModelConfig
 * @property {string} name - Actual model name sent to the provider
 * @property {string} baseURL - Provider API base URL
 * @property {string} apiKey - API key (resolved from env vars)
 * @property {number|null} maxTokens - Maximum output tokens cap
 */

/**
 * @typedef {Object} RouterConfig
 * @property {string} [default] - Default model ID (fallback when no other match)
 * @property {string} [image] - Model for image/vision scenarios
 * @property {string} [haiku] - Model for Haiku family requests
 * @property {string} [sonnet] - Model for Sonnet family requests
 * @property {string} [opus] - Model for Opus family requests
 */

/**
 * @typedef {Object} AppConfig
 * @property {number} port - Proxy port
 * @property {boolean} debug - Debug mode flag
 * @property {Record<string, ModelConfig>} models - Available model configurations
 * @property {RouterConfig} Router - Scenario routing rules
 */

/** @type {AppConfig} */
let config = { port: DEFAULT_PORT, models: {}, Router: {}, debug: false };

/**
 * Resolves environment variable references in string values.
 * Supports ${VAR} and $VAR syntax.
 * @param {string} value - The value to resolve
 * @returns {string} Resolved value or original if env var not found
 */
function resolveEnvVar(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('${') && value.endsWith('}')) {
    const name = value.slice(2, -1);
    const resolved = process.env[name];
    if (!resolved) {
      console.warn(`Warning: env var ${value} is not set, using empty string`);
      return '';
    }
    return resolved;
  }
  if (value.startsWith('$')) {
    const name = value.slice(1);
    const resolved = process.env[name];
    if (!resolved) {
      console.warn(`Warning: env var $${name} is not set, using empty string`);
      return '';
    }
    return resolved;
  }
  return value;
}

/** Reloads configuration from disk and logs changes */
function reloadConfig() {
  const oldRouter = JSON.stringify(config.Router);
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    const rawPort = process.env.ROUTER_PORT;
    const parsedPort = rawPort ? parseInt(rawPort, 10) : (parsed.port || DEFAULT_PORT);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Invalid port: ${rawPort || parsed.port}. Must be integer 1-65535`);
    }
    config.port = parsedPort;
    config.debug = parsed.debug || false;
    config.Router = parsed.Router || {};
    config.LoadBalancer = parsed.LoadBalancer || {};

    config.models = {};
    for (const [id, m] of Object.entries(parsed.models || {})) {
      config.models[id] = {
        name: m.name || id,
        baseURL: resolveEnvVar(m.baseURL),
        apiKey: resolveEnvVar(m.apiKey),
        maxTokens: m.maxTokens || null,
      };
    }

    // Validate: reject model config IDs that collide with Router keys
    for (const modelId of Object.keys(config.models)) {
      if (modelId in config.Router) {
        throw new Error(`Config collision: model ID "${modelId}" conflicts with Router key. Router keys are reserved.`);
      }
    }

    // Validate LB groups
    const knownStrategies = Object.keys(strategies);
    const validGroupKeys = new Set();
    for (const [key, entry] of Object.entries(config.Router)) {
      if (typeof entry === 'object' && entry !== null) {
        if (!entry.strategy) throw new Error(`LB group "${key}" missing "strategy" field`);
        if (!knownStrategies.includes(entry.strategy)) {
          throw new Error(`LB group "${key}" has unknown strategy "${entry.strategy}". Available: ${knownStrategies.join(', ')}`);
        }
        if (!Array.isArray(entry.providers) || entry.providers.length === 0) {
          throw new Error(`LB group "${key}" must have a non-empty "providers" array`);
        }
        const seenIds = new Set();
        for (const p of entry.providers) {
          if (!p.id) throw new Error(`LB group "${key}" has a provider missing "id"`);
          if (!config.models[p.id]) throw new Error(`LB group "${key}" references unknown model "${p.id}"`);
          if (seenIds.has(p.id)) throw new Error(`LB group "${key}" has duplicate provider "${p.id}"`);
          seenIds.add(p.id);
          if (!Number.isInteger(p.maxConns) || p.maxConns < 1) {
            throw new Error(`LB group "${key}" provider "${p.id}" has invalid maxConns (must be positive integer)`);
          }
        }
        validGroupKeys.add(key);
      }
    }

    // Clean up lbState for removed groups on hot-reload
    for (const key of lbState.keys()) {
      if (!validGroupKeys.has(key)) lbState.delete(key);
    }

    const newRouter = JSON.stringify(config.Router);
    const changed = oldRouter !== newRouter;

    L.info(`Config loaded: ${Object.keys(config.models).length} models, debug=${config.debug}`);
    if (changed) {
      L.info(`Router changed: ${oldRouter} -> ${newRouter}`);
      for (const [scenario, modelId] of Object.entries(config.Router)) {
        if (typeof modelId === 'string') {
          const m = config.models[modelId];
          L.info(`  ${scenario}: ${modelId} -> ${m?.baseURL || '?'} (${m?.name || modelId})`);
        } else if (typeof modelId === 'object' && modelId !== null) {
          const providerList = modelId.providers.map(p => `${p.id}(${p.maxConns})`).join(', ');
          L.info(`  ${scenario}: [${modelId.strategy}] ${providerList}`);
        }
      }
    }
  } catch (e) {
    L.error(`Config error: ${e.message}`);
  }
}

reloadConfig();

watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  L.info('Config file changed, reloading...');
  reloadConfig();
});

/** Selects a provider, passing logger to the LB module. */
function selectProviderWithLog(groupKey, group) {
  return selectProvider(groupKey, group, L);
}

/**
 * Resolves a Router key or model config ID to a routing entry.
 * Router-first: if resolvedKey matches a Router key, that takes precedence.
 * @param {string} resolvedKey - Key returned by detectors or direct lookup
 * @returns {{ type: 'router', key: string, entry: string|object } | { type: 'direct', modelConf: Object, id: string } | null}
 */
function resolveRouterEntry(resolvedKey) {
  const entry = config.Router[resolvedKey];
  if (entry !== undefined) return { type: 'router', key: resolvedKey, entry };
  if (config.models[resolvedKey]) return { type: 'direct', modelConf: config.models[resolvedKey], id: resolvedKey };
  return null;
}

/**
 * Reads the LoadBalancer section from config.
 * @returns {{ showProvider?: boolean }}
 */
function getLbConfig() {
  return config.LoadBalancer || {};
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimates token count from request body using character-based approximation.
 * Uses ~4 chars per token ratio for rough estimation.
 * @param {Object} body - Anthropic API request body
 * @param {Array} [body.messages] - Chat messages
 * @param {string|Array} [body.system] - System prompt
 * @param {Array} [body.tools] - Tool definitions
 * @returns {number} Estimated token count
 */
function estimateTokenCount(body) {
  let charCount = 0;
  const { messages = [], system, tools = [] } = body;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) charCount += part.text.length;
        else if (part.type === 'tool_result') {
          const c = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          charCount += c.length;
        }
      }
    }
  }

  if (typeof system === 'string') charCount += system.length;
  else if (Array.isArray(system)) {
    for (const item of system) {
      if (item.type === 'text') {
        if (typeof item.text === 'string') charCount += item.text.length;
        else if (Array.isArray(item.text)) {
          for (const t of item.text) charCount += (t || '').length;
        }
      }
    }
  }

  for (const tool of tools) {
    if (tool.description) charCount += tool.description.length;
    if (tool.input_schema) charCount += JSON.stringify(tool.input_schema).length;
  }

  return Math.ceil(charCount / TOKEN_CHAR_RATIO);
}

// ─── Scenario Detectors ──────────────────────────────────────────────────────

/**
 * @typedef {Object} DetectionContext
 * @property {number} tokenCount - Estimated token count of the request
 * @property {AppConfig} config - Current application configuration
 */

/**
 * @typedef {Object} ScenarioDetector
 * @property {string} name - Unique detector identifier
 * @property {number} priority - Lower values = higher priority (checked first)
 * @property {boolean} [custom] - Whether this is a user-defined detector
 * @property {(body: Object, ctx: DetectionContext) => string|null} detect
 *           Returns model ID if scenario matches, null otherwise
 */

/** Wrappers that add logging around imported detectors */
const detectModelFamilyLogged = (body, ctx) => {
  const result = detectModelFamily(body, ctx);
  if (result) L.route(`modelFamily: ${body.model} -> ${result}`);
  return result;
};
const detectImageLogged = (body, ctx) => {
  const result = detectImage(body, ctx);
  if (result) L.route(`image: detected in messages`);
  return result;
};

/** @type {ScenarioDetector[]} */
const builtinDetectors = [
  { name: 'explicit',    priority: 0, detect: detectExplicitModel },
  { name: 'image',       priority: 5, detect: detectImageLogged },
  { name: 'modelFamily', priority: 8, detect: detectModelFamilyLogged },
];

/** @type {ScenarioDetector[]} */
let allDetectors = [...builtinDetectors];

/**
 * Loads custom scenario detectors from the external module.
 * Custom detectors are merged with built-in ones and sorted by priority.
 */
async function loadCustomDetectors() {
  if (existsSync(CUSTOM_SCENARIOS_PATH)) {
    try {
      const custom = await import(`file://${CUSTOM_SCENARIOS_PATH}?t=${Date.now()}`);
      const customDets = (custom.detectors || []).map(d => ({ ...d, custom: true }));
      allDetectors = [...builtinDetectors, ...customDets].sort((a, b) => a.priority - b.priority);
      L.info(`Loaded ${customDets.length} custom detectors: ${customDets.map(d => d.name).join(', ')}`);
    } catch (e) {
      L.error(`Custom scenarios: ${e.message}`);
      allDetectors = [...builtinDetectors];
    }
  } else {
    allDetectors = [...builtinDetectors];
  }
}

await loadCustomDetectors();

// ─── Scenario Resolution ──────────────────────────────────────────────────────

/**
 * Resolves which model to use for a given request by running all detectors.
 * Detectors are checked in priority order; first match wins.
 * @param {Object} body - Anthropic API request body
 * @param {number} tokenCount - Estimated token count
 * @returns {string|null} Resolved model ID, or null if no match
 */
function resolveModel(body, tokenCount) {
  const ctx = { tokenCount, config };

  for (const detector of allDetectors) {
    const modelId = detector.detect(body, ctx);
    if (modelId) {
      L.route(`${detector.name} -> ${modelId}`);
      return modelId;
    }
  }

  if (body.model && ctx.config.models[body.model]) {
    L.route(`direct -> ${body.model}`);
    return body.model;
  }

  const defaultModel = config.Router.default;
  if (defaultModel) {
    L.route(`default -> default`);
    return 'default';
  }

  return null;
}

// ─── Debug Dump ───────────────────────────────────────────────────────────────

/**
 * Extracts a session identifier from request metadata for debug file organization.
 * Falls back to today's date (YYYYMMDD) if no session ID found.
 * @param {Object} body - Request body
 * @returns {string} Session identifier
 */
function extractSessionId(body) {
  try {
    const raw = body.metadata?.user_id;
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      if (parsed.session_id) return parsed.session_id;
    }
  } catch { /* non-critical: session ID extraction is best-effort */ }
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Sanitizes a model ID for use in filenames.
 * @param {string} id - Model ID to sanitize
 * @returns {string} Safe filename component
 */
function sanitizeModelId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Generates a unique debug file tag from timestamp, random number, and model ID.
 * @param {string} modelId - Model ID for the tag
 * @returns {string} Unique file tag
 */
function debugFileTag(modelId) {
  const ts = Date.now();
  const rand = String(randomInt(100, 1000));
  const safe = sanitizeModelId(modelId);
  return `${ts}_${rand}_${safe}`;
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 * @param {string} dir - Directory path
 */
function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { /* best-effort: dir may already exist */ }
}

/**
 * Writes debug request dumps (original and processed) to the session directory.
 */
function dumpDebugReq(sessionDir, tag, parsedBefore, parsedAfter, target, modelId) {
  ensureDir(sessionDir);
  const content1 = JSON.stringify({ time: nowLocal(), model: parsedBefore.model, target, routedModel: modelId, body: parsedBefore }, null, 2);
  const content2 = JSON.stringify({ time: nowLocal(), target, body: parsedAfter }, null, 2);
  writeFile(join(sessionDir, `${tag}_req.json`), content1, () => {});
  writeFile(join(sessionDir, `${tag}_processed.json`), content2, () => {});
  L.debug(`Debug dump: ${tag}`);
}

/**
 * Writes debug response dump to the session directory.
 */
function dumpDebugRes(sessionDir, tag, statusCode, headers, body) {
  ensureDir(sessionDir);
  const header = `# ${nowLocal()} | status: ${statusCode} | content-type: ${headers['content-type']}\n\n`;
  writeFile(join(sessionDir, `${tag}_res.txt`), header + body, () => {});
}

// ─── Request Forwarding ───────────────────────────────────────────────────────

let requestId = 0;

/**
 * Forwards a POST request to the target URL and streams the response back.
 * @param {string} targetURL - Full URL to forward to
 * @param {Object} fwdHeaders - HTTP headers for the forwarded request
 * @param {Buffer} bodyBuf - Request body as a Buffer
 * @param {import('node:http').ServerResponse} res - Client response object
 * @param {string|null} debugTag - Debug file tag (null if debug disabled)
 * @param {string|null} sessionDir - Debug session directory (null if debug disabled)
 * @param {{ onClose?: () => void, providerId?: string, parsed?: Object }} [opts] - Optional callbacks and metadata
 */
function forwardRequest(targetURL, fwdHeaders, bodyBuf, res, debugTag, sessionDir, opts = {}) {
  let url;
  try { url = new URL(targetURL); }
  catch {
    opts.onClose?.();
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: `Bad target URL: ${targetURL}` } }));
    }
    return;
  }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? httpsRequest : httpRequest;
  const lbConf = getLbConfig();

  const proxyReq = lib({
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: { ...fwdHeaders, host: url.host, 'content-length': bodyBuf.length },
  }, (proxyRes) => {
    // H2: Handle upstream response errors to prevent unhandled exception crashes
    proxyRes.on('error', (e) => {
      L.error(`Upstream response error: ${e.message}`);
      opts.onClose?.();
      if (!res.writableEnded) res.end();
    });

    // Connection cleanup on response close (normal completion + client disconnect)
    proxyRes.on('close', opts.onClose || (() => {}));

    if (!res.headersSent) {
      const headers = { ...proxyRes.headers };

      // Inject X-Router-Provider header for visibility
      if (opts.providerId && lbConf.showProvider) {
        headers['x-router-provider'] = opts.providerId;
      }

      res.writeHead(proxyRes.statusCode, headers);
    }

    // SSE provider comment injection: double-gated on stream=true AND content-type
    if (opts.providerId && lbConf.showProvider && opts.parsed?.stream === true) {
      const ct = proxyRes.headers['content-type'] || '';
      if (ct.includes('text/event-stream')) {
        res.write(`: router_provider: ${opts.providerId}\n\n`);
      }
    }

    // H1: Use Transform stream for debug capture instead of separate on('data')
    //     This prevents data loss from flowing mode race condition
    if (config.debug) {
      const debugChunks = [];
      const debugTransform = new Transform({
        transform(chunk, _encoding, cb) {
          debugChunks.push(chunk);
          cb(null, chunk);
        },
        flush(cb) {
          const body = Buffer.concat(debugChunks).toString('utf8');
          dumpDebugRes(sessionDir, debugTag, proxyRes.statusCode, proxyRes.headers, body);
          cb();
        },
      });
      proxyRes.pipe(debugTransform).pipe(res);
    } else {
      proxyRes.pipe(res);
    }
  });

  // H3: Add upstream timeout to prevent connection count leaks from hanging connections
  const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  proxyReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    L.warn(`Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
    proxyReq.destroy(new Error('Upstream timeout'));
  });

  proxyReq.on('error', (e) => {
    L.error(`Forward error: ${e.message} [target=${targetURL}, code=${e.code || 'unknown'}]`);
    opts.onClose?.();
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: `Proxy error: ${e.message}` } }));
    }
  });

  proxyReq.write(bodyBuf);
  proxyReq.end();
}

/**
 * Forwards non-POST requests (GET, DELETE, etc.) to the default model's base URL.
 * @param {string} targetURL - Full URL to forward to
 * @param {string} method - HTTP method
 * @param {Object} reqHeaders - Original request headers
 * @param {import('node:http').ServerResponse} res - Client response object
 * @param {(() => void)} [onClose] - Callback when connection completes/fails
 */
function forwardNonPost(targetURL, method, reqHeaders, res, onClose) {
  let url;
  try { url = new URL(targetURL); } catch { onClose?.(); res.writeHead(502); return res.end('Bad gateway'); }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? httpsRequest : httpRequest;

  const proxyReq = lib({
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method,
    headers: { ...reqHeaders, host: url.host },
  }, (proxyRes) => {
    proxyRes.on('error', (e) => {
      L.error(`Non-POST upstream response error: ${e.message}`);
      onClose?.();
      if (!res.writableEnded) res.end();
    });
    proxyRes.on('close', onClose || (() => {}));
    if (!res.headersSent) res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(5 * 60 * 1000, () => {
    proxyReq.destroy(new Error('Upstream timeout'));
  });

  proxyReq.on('error', () => { onClose?.(); if (!res.headersSent) { res.writeHead(502); res.end('Bad gateway'); } });
  proxyReq.end();
}

// ─── Model Lookup & Request Routing ───────────────────────────────────────────

/**
 * Gets model configuration by ID.
 * @param {string} modelId
 * @returns {ModelConfig|null}
 */
function getModelConfig(modelId) {
  return config.models[modelId] || null;
}

/**
 * Falls back to the first configured model when no explicit default is available.
 * @returns {{ id: string, providerId: string } & ModelConfig | null}
 */
function firstModelFallback() {
  const firstId = Object.keys(config.models)[0];
  if (firstId) return { id: firstId, providerId: firstId, ...config.models[firstId] };
  return null;
}

/**
 * Gets the default model configuration.
 * Handles both string Router.default (single provider) and object (LB group).
 * Falls back to the first configured model if no explicit default.
 * @returns {{ id: string, providerId: string } & ModelConfig | null}
 */
function getDefaultModelConfig() {
  const defaultEntry = config.Router.default;
  if (!defaultEntry) return firstModelFallback();
  // String: single provider
  if (typeof defaultEntry === 'string') {
    if (config.models[defaultEntry]) return { id: defaultEntry, providerId: defaultEntry, ...config.models[defaultEntry] };
    return firstModelFallback();
  }
  // Object: LB group — select a provider
  if (typeof defaultEntry === 'object') {
    const pickedId = selectProviderWithLog('default', defaultEntry);
    if (pickedId && config.models[pickedId]) {
      return { id: pickedId, providerId: pickedId, ...config.models[pickedId] };
    }
    return firstModelFallback();
  }
  return null;
}

/**
 * Main routing logic: parses request, resolves target model, and forwards.
 * Uses resolveRouterEntry to disambiguate Router keys from model config IDs.
 * @param {string} pathname - Request URL pathname (e.g., /v1/messages)
 * @param {Object} reqHeaders - Original request headers
 * @param {string} rawBody - Raw request body (JSON string)
 * @param {import('node:http').ServerResponse} res - Client response object
 */
function routeAndForward(pathname, reqHeaders, rawBody, res) {
  let parsed;
  try { parsed = JSON.parse(rawBody); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { message: 'Invalid JSON' } }));
  }

  // Snapshot original request before any modification
  const originalParsed = JSON.parse(rawBody);

  // Resolve model key (Router key or model config ID)
  const resolvedKey = resolveModel(parsed, estimateTokenCount(parsed));
  if (!resolvedKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { message: 'No model resolved and no default configured' } }));
  }

  // Disambiguate: Router key vs model config ID
  const routing = resolveRouterEntry(resolvedKey);

  let modelConf;
  let providerId;
  let groupKey = null;

  if (!routing) {
    // Unknown key: fall back to default
    const defaultConf = getDefaultModelConfig();
    if (!defaultConf) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: `Unknown model "${resolvedKey}" and no default configured` } }));
    }
    L.warn(`Unknown key "${resolvedKey}", using default (${defaultConf.id})`);
    modelConf = defaultConf;
    providerId = defaultConf.providerId;
  } else if (routing.type === 'router' && typeof routing.entry === 'string') {
    // Router key → single provider (backward compatible)
    const mc = getModelConfig(routing.entry);
    if (!mc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: `Router.${routing.key} references unknown model "${routing.entry}"` } }));
    }
    modelConf = mc;
    providerId = routing.entry;
  } else if (routing.type === 'router' && typeof routing.entry === 'object') {
    // Router key → LB group
    groupKey = routing.key;
    const pickedId = selectProviderWithLog(groupKey, routing.entry);
    if (!pickedId) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: `LB group "${groupKey}" has no available providers` } }));
    }
    const mc = getModelConfig(pickedId);
    if (!mc) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: `LB selected provider "${pickedId}" not in models config` } }));
    }
    modelConf = mc;
    providerId = pickedId;
  } else {
    // Direct model config ID (from detectExplicitModel or direct lookup)
    modelConf = routing.modelConf;
    providerId = routing.id;
  }

  // Connection tracking
  const tracker = withConnTracking(providerId);

  // Log routing decision
  if (groupKey) {
    L.route(`${groupKey}: ${providerId} [active: ${getConns(providerId)}/${routing.entry?.providers?.find(p => p.id === providerId)?.maxConns || '?'}]`);
  }

  const target = modelConf.baseURL.replace(/\/+$/, '') + pathname;
  const actualModel = modelConf.name || providerId;
  const originalModel = parsed.model;

  // Build forwarded body immutably — never mutate the original parsed object
  const forwarded = {
    ...parsed,
    model: actualModel,
    ...(modelConf.maxTokens && parsed.max_tokens && parsed.max_tokens > modelConf.maxTokens
      ? { max_tokens: modelConf.maxTokens }
      : {}),
  };

  if (originalModel !== actualModel) {
    L.info(`Model: ${originalModel} -> ${actualModel}`);
  }
  if (modelConf.maxTokens && parsed.max_tokens && parsed.max_tokens > modelConf.maxTokens) {
    L.info(`max_tokens: ${parsed.max_tokens} -> ${modelConf.maxTokens}`);
  }

  const bodyBuf = Buffer.from(JSON.stringify(forwarded));

  const fwdHeaders = { ...reqHeaders };
  delete fwdHeaders['content-length'];
  delete fwdHeaders['transfer-encoding'];
  delete fwdHeaders.connection;

  if (modelConf.apiKey) {
    fwdHeaders['x-api-key'] = modelConf.apiKey;
    fwdHeaders['authorization'] = `Bearer ${modelConf.apiKey}`;
  }

  L.info(`-> ${target} (model: ${actualModel})`);

  // Debug dump
  const tag = config.debug ? debugFileTag(actualModel) : null;
  const sessionDir = config.debug ? join(DEBUG_DIR, extractSessionId(originalParsed)) : null;
  if (config.debug) {
    dumpDebugReq(sessionDir, tag, originalParsed, forwarded, target, actualModel);
  }

  forwardRequest(target, fwdHeaders, bodyBuf, res, tag, sessionDir, {
    onClose: tracker.cleanup,
    providerId,
    parsed: forwarded,
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    // Build LB status from active LB groups (no credentials exposed)
    const lbStatus = {};
    for (const [key, entry] of Object.entries(config.Router)) {
      if (typeof entry === 'object' && entry !== null && Array.isArray(entry.providers)) {
        lbStatus[key] = {
          strategy: entry.strategy,
          providers: entry.providers.map(p => ({
            id: p.id,
            activeConns: getConns(p.id),
            maxConns: p.maxConns,
          })),
        };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      models: Object.keys(config.models),
      router: config.Router,
      loadBalancer: { groups: lbStatus },
      debug: config.debug,
    }));
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    const now = new Date().toISOString();
    const data = Object.entries(config.models).map(([id, m]) => ({
      id,
      type: 'model',
      display_name: id,
      created_at: now,
    }));
    const body = JSON.stringify({
      data,
      has_more: false,
      first_id: data[0]?.id || '',
      last_id: data[data.length - 1]?.id || '',
    });
    L.info(`GET /v1/models -> ${data.length} models`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }

  if (req.method !== 'POST') {
    const defaultConf = getDefaultModelConfig();
    if (defaultConf) {
      const tracker = withConnTracking(defaultConf.providerId);
      const target = defaultConf.baseURL.replace(/\/+$/, '') + pathname;
      return forwardNonPost(target, req.method, req.headers, res, tracker.cleanup);
    }
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  const chunks = [];
  for await (const chunk of req) { chunks.push(chunk); }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  return routeAndForward(pathname, req.headers, rawBody, res);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

try { mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { console.error('Log dir creation failed:', e.message); }
// Append a startup separator instead of truncating — preserves log history
try { writeFileSync(LOG_PATH, `\n${'='.repeat(60)}\n`, { flag: 'a' }); } catch (e) { console.error('Log init failed:', e.message); }

const port = config.port || DEFAULT_PORT;
server.listen(port, '127.0.0.1', () => {
  L.info(`Custom Model Proxy started on http://127.0.0.1:${port}`);
  L.info(`Config: ${CONFIG_PATH}`);
  L.info(`Models: ${Object.keys(config.models).join(', ') || 'none'}`);
  L.info(`Debug: ${config.debug ? 'ON' : 'OFF'}`);
  for (const [scenario, modelId] of Object.entries(config.Router)) {
    if (typeof modelId === 'string') {
      const m = config.models[modelId];
      L.info(`  ${scenario}: ${modelId} -> ${m?.baseURL || '?'} (${m?.name || modelId})`);
    } else if (typeof modelId === 'object' && modelId !== null) {
      const providerList = modelId.providers.map(p => `${p.id}(${p.maxConns})`).join(', ');
      L.info(`  ${scenario}: [${modelId.strategy}] ${providerList}`);
    }
  }
  writeFileSync(PID_PATH, String(process.pid));
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  L.info('Shutting down...');
  unwatchFile(CONFIG_PATH);
  try { unlinkSync(PID_PATH); } catch (e) { /* best-effort during shutdown */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
