import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Integration test: starts the proxy server and sends real HTTP requests
// Uses a temporary config directory to avoid interfering with real config

const TEST_PORT = 18082;
const TEST_DIR = join(tmpdir(), `ccr-routing-test-${Date.now()}`);
const CONFIG_PATH = join(TEST_DIR, '.claude-custom-router.json');
const DATA_DIR = join(TEST_DIR, '.claude-custom-router.d');
const LOG_DIR = join(TEST_DIR, 'logs');
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Minimal config with a model pointing to a non-existent backend
// (we only test routing decisions, not actual forwarding)
const TEST_CONFIG = {
  port: TEST_PORT,
  debug: false,
  Router: {
    default: 'test-model',
    image: 'test-model',
    haiku: 'test-model',
    sonnet: 'test-model',
    opus: 'test-model',
  },
  models: {
    'test-model': {
      name: 'test-model-name',
      baseURL: 'http://127.0.0.1:19999', // Non-existent, will fail but routing is tested
      apiKey: 'test-key',
    },
  },
};

let serverProcess = null;

describe('HTTP Server Integration', () => {
  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it('should start the proxy server', async () => {
    const { spawn } = await import('node:child_process');
    serverProcess = spawn('node', ['src/custom-model-proxy.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: TEST_DIR,
        ROUTER_CONFIG_PATH: CONFIG_PATH,
        ROUTER_LOG_DIR: LOG_DIR,
        ROUTER_PORT: String(TEST_PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to start
    await new Promise(resolve => {
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('started on')) resolve();
      });
      serverProcess.stderr.on('data', (data) => {
        // Ignore stderr
      });
      setTimeout(resolve, 3000);
    });

    assert.ok(serverProcess.pid);
  });

  it('should respond to /health endpoint', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.ok(data.models.includes('test-model'));
  });

  it('should respond to GET /v1/models', async () => {
    const res = await fetch(`${BASE_URL}/v1/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.data));
    assert.equal(data.data.length, 1);
    assert.equal(data.data[0].id, 'test-model');
    assert.equal(data.data[0].type, 'model');
    assert.equal(data.has_more, false);
  });

  it('should route POST requests (will fail at upstream but routing works)', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });
    // Will be 502 because upstream doesn't exist, but proves routing happened
    assert.equal(res.status, 502);
  });

  it('should return 400 for invalid JSON body', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.type, 'error');
    assert.ok(data.error.message.includes('Invalid JSON'));
  });

  it('should return 400 when no model resolved', async () => {
    // Create a config with no default and no matching model
    const noDefaultConfig = {
      port: TEST_PORT,
      Router: {},
      models: {},
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(noDefaultConfig));

    // Wait for config reload
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.message.includes('No model resolved'));

    // Restore config
    writeFileSync(CONFIG_PATH, JSON.stringify(TEST_CONFIG));
  });
});
