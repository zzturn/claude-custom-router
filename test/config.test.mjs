import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test config loading logic in isolation
// We simulate the resolveEnvVar and config parsing

function resolveEnvVar(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('${') && value.endsWith('}'))
    return process.env[value.slice(2, -1)] || value;
  if (value.startsWith('$'))
    return process.env[value.slice(1)] || value;
  return value;
}

function parseConfig(raw) {
  const parsed = JSON.parse(raw);
  const config = {
    port: parsed.port || 8082,
    debug: parsed.debug || false,
    Router: parsed.Router || {},
    models: {},
  };

  for (const [id, m] of Object.entries(parsed.models || {})) {
    config.models[id] = {
      name: m.name || id,
      baseURL: resolveEnvVar(m.baseURL),
      apiKey: resolveEnvVar(m.apiKey),
      maxTokens: m.maxTokens || null,
    };
  }

  return config;
}

describe('resolveEnvVar', () => {
  it('should resolve ${VAR} syntax', () => {
    process.env.TEST_KEY = 'resolved-value';
    assert.equal(resolveEnvVar('${TEST_KEY}'), 'resolved-value');
    delete process.env.TEST_KEY;
  });

  it('should resolve $VAR syntax', () => {
    process.env.TEST_KEY2 = 'resolved';
    assert.equal(resolveEnvVar('$TEST_KEY2'), 'resolved');
    delete process.env.TEST_KEY2;
  });

  it('should return original string when env var not found', () => {
    assert.equal(resolveEnvVar('${NONEXISTENT_VAR}'), '${NONEXISTENT_VAR}');
    assert.equal(resolveEnvVar('$NONEXISTENT_VAR'), '$NONEXISTENT_VAR');
  });

  it('should return non-string values unchanged', () => {
    assert.equal(resolveEnvVar(42), 42);
    assert.equal(resolveEnvVar(null), null);
    assert.equal(resolveEnvVar(undefined), undefined);
  });

  it('should return plain strings unchanged', () => {
    assert.equal(resolveEnvVar('https://api.example.com'), 'https://api.example.com');
  });
});

describe('parseConfig', () => {
  it('should parse a valid config with all fields', () => {
    const config = parseConfig(JSON.stringify({
      port: 9090,
      debug: true,
      Router: { default: 'model-a' },
      models: {
        'model-a': {
          name: 'actual-name',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          maxTokens: 4096,
        },
      },
    }));

    assert.equal(config.port, 9090);
    assert.equal(config.debug, true);
    assert.equal(config.Router.default, 'model-a');
    assert.equal(config.models['model-a'].name, 'actual-name');
    assert.equal(config.models['model-a'].baseURL, 'https://api.example.com/v1');
    assert.equal(config.models['model-a'].apiKey, 'sk-test');
    assert.equal(config.models['model-a'].maxTokens, 4096);
  });

  it('should use defaults for missing fields', () => {
    const config = parseConfig(JSON.stringify({}));
    assert.equal(config.port, 8082);
    assert.equal(config.debug, false);
    assert.deepEqual(config.Router, {});
    assert.deepEqual(config.models, {});
  });

  it('should use model ID as name when name is not provided', () => {
    const config = parseConfig(JSON.stringify({
      models: {
        'my-model': { baseURL: 'https://api.example.com', apiKey: 'key' },
      },
    }));
    assert.equal(config.models['my-model'].name, 'my-model');
  });

  it('should resolve env vars in model config', () => {
    process.env.MY_TEST_API_KEY = 'secret-key';
    process.env.MY_TEST_BASE_URL = 'https://custom.api.com';
    const config = parseConfig(JSON.stringify({
      models: {
        'test': {
          baseURL: '${MY_TEST_BASE_URL}',
          apiKey: '$MY_TEST_API_KEY',
        },
      },
    }));

    assert.equal(config.models.test.baseURL, 'https://custom.api.com');
    assert.equal(config.models.test.apiKey, 'secret-key');
    delete process.env.MY_TEST_API_KEY;
    delete process.env.MY_TEST_BASE_URL;
  });

  it('should set maxTokens to null when not provided', () => {
    const config = parseConfig(JSON.stringify({
      models: {
        'test': { baseURL: 'https://api.example.com', apiKey: 'key' },
      },
    }));
    assert.equal(config.models.test.maxTokens, null);
  });
});

describe('config file I/O', () => {
  const testDir = join(tmpdir(), `ccr-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch {}
  });

  it('should read and parse config from disk', () => {
    const configPath = join(testDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 3000,
      models: { 'm1': { name: 'm1', baseURL: 'http://localhost', apiKey: 'k' } },
    }));

    const raw = readFileSync(configPath, 'utf8');
    const config = parseConfig(raw);
    assert.equal(config.port, 3000);
    assert.ok(config.models.m1);
  });
});
