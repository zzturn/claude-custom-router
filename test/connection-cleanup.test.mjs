import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROXY_PORT = 18083;
const UPSTREAM_PORT = 19998;
const TEST_DIR = join(tmpdir(), `ccr-conn-cleanup-${Date.now()}`);
const CONFIG_PATH = join(TEST_DIR, '.claude-custom-router.json');
const DATA_DIR = join(TEST_DIR, '.claude-custom-router.d');
const LOG_DIR = join(TEST_DIR, 'logs');
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;

const TEST_CONFIG = {
  port: PROXY_PORT,
  debug: false,
  upstreamTimeoutMs: 60_000,
  pools: {
    'default-pool': {
      strategy: 'priority-fallback',
      providers: [{ provider: 'slow-provider', maxConns: 5 }],
    },
  },
  routes: {
    default: { pool: 'default-pool' },
  },
  providers: {
    'slow-provider': {
      model: 'slow-provider-name',
      baseURL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      apiKey: 'test-key',
    },
  },
};

let serverProcess = null;
let upstreamServer = null;
let waitForUpstreamRequest = null;
let resolveUpstreamRequest = null;
const sockets = new Set();

function resetUpstreamRequestWait() {
  waitForUpstreamRequest = new Promise((resolve) => {
    resolveUpstreamRequest = resolve;
  });
}

async function waitForActiveConns(expected, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    const actual = data.loadBalancer.pools['default-pool'].providers[0].activeConns;
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for activeConns=${expected}`);
}

describe('connection cleanup on client abort', () => {
  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));

    resetUpstreamRequestWait();
    upstreamServer = createServer((req, _res) => {
      resolveUpstreamRequest?.();
      req.on('data', () => {});
    });
    upstreamServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
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

    await new Promise((resolve) => {
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('started on')) resolve();
      });
      setTimeout(resolve, 3000);
    });
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const socket of sockets) socket.destroy();
    if (upstreamServer) {
      await new Promise((resolve) => upstreamServer.close(resolve));
    }
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it('should decrement activeConns promptly when the downstream client aborts', async () => {
    resetUpstreamRequestWait();

    const controller = new AbortController();
    const requestPromise = fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      }),
      signal: controller.signal,
    });

    await waitForUpstreamRequest;
    await waitForActiveConns(1);

    controller.abort();
    await assert.rejects(requestPromise, /AbortError/);
    await waitForActiveConns(0);
  });
});
