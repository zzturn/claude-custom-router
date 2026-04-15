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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomInt } from 'node:crypto';

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
    const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim());
    try { process.kill(pid, 'SIGTERM'); console.log(`Stopped proxy (PID ${pid})`); }
    catch { console.log(`Process ${pid} not running, cleaning up`); }
    try { unlinkSync(PID_PATH); } catch {}
  } else { console.log('Proxy not running'); }
  process.exit(0);
}

if (process.argv.includes('--status')) {
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim());
    try { process.kill(pid, 0); console.log(`Proxy running (PID ${pid})`); }
    catch { console.log(`Proxy not running (stale PID: ${pid})`); }
  } else { console.log('Proxy not running'); }
  process.exit(0);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

/**
 * Returns current timestamp in Beijing time (UTC+8) formatted as YYYY-MM-DD HH:mm:ss
 * @returns {string}
 */
function nowBJ() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Appends a timestamped log line to both console and log file
 * @param {string} level - Log level (INFO, ROUTE, WARN, ERROR, DEBUG)
 * @param {string} msg - Log message
 */
function log(level, msg) {
  const line = `[${nowBJ()}] [${level}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_PATH, line + '\n', { flag: 'a' }); } catch {}
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
  if (value.startsWith('${') && value.endsWith('}'))
    return process.env[value.slice(2, -1)] || value;
  if (value.startsWith('$'))
    return process.env[value.slice(1)] || value;
  return value;
}

/** Reloads configuration from disk and logs changes */
function reloadConfig() {
  const oldRouter = JSON.stringify(config.Router);
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    config.port = process.env.ROUTER_PORT ? parseInt(process.env.ROUTER_PORT) : (parsed.port || DEFAULT_PORT);
    config.debug = parsed.debug || false;
    config.Router = parsed.Router || {};

    config.models = {};
    for (const [id, m] of Object.entries(parsed.models || {})) {
      config.models[id] = {
        name: m.name || id,
        baseURL: resolveEnvVar(m.baseURL),
        apiKey: resolveEnvVar(m.apiKey),
        maxTokens: m.maxTokens || null,
      };
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

/**
 * Detects explicit model override via comma-separated model IDs.
 * e.g., "original-model,my-custom-model" routes to "my-custom-model"
 */
function detectExplicitModel(body, ctx) {
  if (body.model && body.model.includes(',')) {
    const modelId = body.model;
    if (ctx.config.models[modelId]) return modelId;
    const afterComma = body.model.split(',').slice(1).join(',');
    if (ctx.config.models[afterComma]) return afterComma;
    return modelId;
  }
  return null;
}

/**
 * Model families detected from Claude model IDs, ordered by specificity.
 * Opus checked first to avoid "sonnet" matching inside compound names.
 */
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'];

/**
 * Detects model family from the Claude model ID in the request.
 * Maps body.model (e.g., "claude-sonnet-4-6") to Router.haiku/sonnet/opus config.
 */
function detectModelFamily(body, ctx) {
  if (!body.model) return null;
  const modelLower = body.model.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (modelLower.includes(family) && ctx.config.Router[family]) {
      L.route(`modelFamily: ${body.model} -> ${family}`);
      return ctx.config.Router[family];
    }
  }
  return null;
}

/**
 * Detects image/vision requests by scanning recent messages for image content.
 * Only checks the last few user messages to avoid unnecessary scanning.
 */
function detectImage(body, ctx) {
  if (!ctx.config.Router.image) return null;
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image' || part.type === 'image_url') {
          L.route(`image: ${part.type} in msg[${i}]`);
          return ctx.config.Router.image;
        }
      }
    }
  }
  return null;
}

/** @type {ScenarioDetector[]} */
const builtinDetectors = [
  { name: 'explicit',    priority: 0, detect: detectExplicitModel },
  { name: 'image',       priority: 5, detect: detectImage },
  { name: 'modelFamily', priority: 8, detect: detectModelFamily },
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
    L.route(`default -> ${defaultModel}`);
    return defaultModel;
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
  } catch {}
  const d = new Date(Date.now() + 8 * 3600_000);
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
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * Writes debug request dumps (original and processed) to the session directory.
 */
function dumpDebugReq(sessionDir, tag, parsedBefore, parsedAfter, target, modelId) {
  ensureDir(sessionDir);
  const content1 = JSON.stringify({ time: nowBJ(), model: parsedBefore.model, target, routedModel: modelId, body: parsedBefore }, null, 2);
  const content2 = JSON.stringify({ time: nowBJ(), target, body: parsedAfter }, null, 2);
  writeFile(join(sessionDir, `${tag}_req.json`), content1, () => {});
  writeFile(join(sessionDir, `${tag}_processed.json`), content2, () => {});
  L.debug(`Debug dump: ${tag}`);
}

/**
 * Writes debug response dump to the session directory.
 */
function dumpDebugRes(sessionDir, tag, statusCode, headers, body) {
  ensureDir(sessionDir);
  const header = `# ${nowBJ()} | status: ${statusCode} | content-type: ${headers['content-type']}\n\n`;
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
 */
function forwardRequest(targetURL, fwdHeaders, bodyBuf, res, debugTag, sessionDir) {
  let url;
  try { url = new URL(targetURL); }
  catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: `Bad target URL: ${targetURL}` } }));
    }
    return;
  }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? httpsRequest : httpRequest;

  const proxyReq = lib({
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: { ...fwdHeaders, host: url.host, 'content-length': bodyBuf.length },
  }, (proxyRes) => {
    const chunks = [];
    if (config.debug) {
      proxyRes.on('data', (chunk) => { chunks.push(chunk); });
      proxyRes.on('end', () => {
        dumpDebugRes(sessionDir, debugTag, proxyRes.statusCode, proxyRes.headers, Buffer.concat(chunks).toString('utf8'));
      });
    }

    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    L.error(`Forward error: ${e.message}`);
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
 */
function forwardNonPost(targetURL, method, reqHeaders, res) {
  let url;
  try { url = new URL(targetURL); } catch { res.writeHead(502); return res.end('Bad gateway'); }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? httpsRequest : httpRequest;

  const proxyReq = lib({
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method,
    headers: { ...reqHeaders, host: url.host },
  }, (proxyRes) => {
    if (!res.headersSent) res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Bad gateway'); } });
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
 * Gets the default model configuration.
 * Falls back to the first configured model if no explicit default.
 * @returns {{ id: string } & ModelConfig | null}
 */
function getDefaultModelConfig() {
  const defaultId = config.Router.default;
  if (defaultId && config.models[defaultId]) return { id: defaultId, ...config.models[defaultId] };
  const firstId = Object.keys(config.models)[0];
  if (firstId) return { id: firstId, ...config.models[firstId] };
  return null;
}

/**
 * Main routing logic: parses request, resolves target model, and forwards.
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

  // Resolve model
  const modelId = resolveModel(parsed, estimateTokenCount(parsed));
  if (!modelId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { message: 'No model resolved and no default configured' } }));
  }

  let modelConf = getModelConfig(modelId);
  if (!modelConf) {
    const defaultConf = getDefaultModelConfig();
    if (defaultConf) {
      L.warn(`Model "${modelId}" not in config, using default (${defaultConf.id})`);
      modelConf = defaultConf;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { message: `Unknown model "${modelId}"` } }));
    }
  }

  const target = modelConf.baseURL.replace(/\/+$/, '') + pathname;
  const actualModel = modelConf.name || modelId;
  const originalModel = parsed.model;
  parsed.model = actualModel;
  if (originalModel !== actualModel) {
    L.info(`Model: ${originalModel} -> ${actualModel}`);
  }

  if (modelConf.maxTokens && parsed.max_tokens) {
    if (parsed.max_tokens > modelConf.maxTokens) {
      L.info(`max_tokens: ${parsed.max_tokens} -> ${modelConf.maxTokens}`);
      parsed.max_tokens = modelConf.maxTokens;
    }
  }

  const bodyBuf = Buffer.from(JSON.stringify(parsed));

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
    dumpDebugReq(sessionDir, tag, originalParsed, parsed, target, actualModel);
  }

  forwardRequest(target, fwdHeaders, bodyBuf, res, tag, sessionDir);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      models: Object.keys(config.models),
      router: config.Router,
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
      const target = defaultConf.baseURL.replace(/\/+$/, '') + pathname;
      return forwardNonPost(target, req.method, req.headers, res);
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

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
try { writeFileSync(LOG_PATH, ''); } catch {}

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
    }
  }
  writeFileSync(PID_PATH, String(process.pid));
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  L.info('Shutting down...');
  unwatchFile(CONFIG_PATH);
  try { unlinkSync(PID_PATH); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
