import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROXY_PORT = 18084;
const UPSTREAM_PORT = 19997;
const TEST_DIR = join(tmpdir(), `ccr-non-2xx-${Date.now()}`);
const CONFIG_PATH = join(TEST_DIR, '.claude-custom-router.json');
const DATA_DIR = join(TEST_DIR, '.claude-custom-router.d');
const LOG_DIR = join(TEST_DIR, 'logs');
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
const ERROR_BODY = JSON.stringify({
  type: 'error',
  error: {
    message: 'rate limited by upstream',
    code: 'too_many_requests',
  },
});

const TEST_CONFIG = {
  port: PROXY_PORT,
  debug: false,
  routes: {
    default: { provider: 'test-provider' },
  },
  providers: {
    'test-provider': {
      model: 'test-model-name',
      baseURL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      apiKey: 'test-key',
    },
  },
};

let serverProcess = null;
let upstreamServer = null;
let stdoutBuffer = '';

async function waitForLog(pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(stdoutBuffer)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for log pattern ${pattern}`);
}

describe('non-2xx upstream logging', () => {
  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));

    upstreamServer = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(ERROR_BODY);
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

    await waitForLog(/started on/);
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

  it('should log upstream response body when status is non-2xx', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-provider',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });

    assert.equal(res.status, 429);
    assert.equal(await res.text(), ERROR_BODY);

    await waitForLog(/Upstream 429 response body/);
    assert.match(stdoutBuffer, /rate limited by upstream/);
    assert.match(stdoutBuffer, /too_many_requests/);
  });
});
