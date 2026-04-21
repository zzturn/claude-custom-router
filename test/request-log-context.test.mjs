import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROXY_PORT = 18085;
const UPSTREAM_PORT = 19996;
const TEST_DIR = join(tmpdir(), `ccr-log-context-${Date.now()}`);
const CONFIG_PATH = join(TEST_DIR, '.claude-custom-router.json');
const DATA_DIR = join(TEST_DIR, '.claude-custom-router.d');
const LOG_DIR = join(TEST_DIR, 'logs');
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
const SESSION_ID = 'abc123-session-xyz';
const SESSION_PREFIX = 'abc123';

const TEST_CONFIG = {
  port: PROXY_PORT,
  debug: true,
  Router: {
    default: 'test-model',
  },
  models: {
    'test-model': {
      name: 'test-model-name',
      baseURL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      apiKey: 'test-key',
    },
  },
};

let serverProcess = null;
let upstreamServer = null;
let stdoutBuffer = '';

async function waitForMatch(regex, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = stdoutBuffer.match(regex);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for pattern ${regex}`);
}

async function waitForFiles(dir, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const files = readdirSync(dir);
      if (files.length > 0) return files;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for files in ${dir}`);
}

describe('request log context', () => {
  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));

    upstreamServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => upstreamServer.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

    const { spawn } = await import('node:child_process');
    serverProcess = spawn('node', ['src/custom-model-proxy.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: TEST_DIR,
        ROUTER_CONFIG_PATH: CONFIG_PATH,
        ROUTER_LOG_DIR: LOG_DIR,
        ROUTER_PORT: String(PROXY_PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
    });

    await waitForMatch(/started on/);
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (upstreamServer) {
      await new Promise((resolve) => upstreamServer.close(resolve));
    }
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it('should include session prefix in request logs and use timestamp_reqid debug tags', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        metadata: {
          user_id: JSON.stringify({ session_id: SESSION_ID }),
        },
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const routeLogMatch = await waitForMatch(new RegExp(`\\[([a-z0-9]{6})\\]\\[${SESSION_PREFIX}\\] test-model -> test-model-name`));
    const reqId = routeLogMatch[1];
    const debugDir = join(LOG_DIR, 'debug', SESSION_ID);
    const debugFiles = await waitForFiles(debugDir);

    assert.ok(debugFiles.some((file) => new RegExp(`^\\d{13}_${reqId}_testmodelname_req\\.json$`).test(file)));
    assert.ok(debugFiles.some((file) => new RegExp(`^\\d{13}_${reqId}_testmodelname_processed\\.json$`).test(file)));
  });
});
