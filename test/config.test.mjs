import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    routes: parsed.routes || {},
    pools: parsed.pools || {},
    loadBalancer: parsed.loadBalancer || {},
    providers: {},
  };

  for (const [id, provider] of Object.entries(parsed.providers || {})) {
    config.providers[id] = {
      model: provider.model || id,
      baseURL: resolveEnvVar(provider.baseURL),
      apiKey: resolveEnvVar(provider.apiKey),
      maxTokens: provider.maxTokens || null,
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
      routes: { default: { provider: 'provider-a' } },
      pools: {
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [{ provider: 'provider-a', maxConns: 3 }],
        },
      },
      loadBalancer: { showProvider: true },
      providers: {
        'provider-a': {
          model: 'actual-model',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          maxTokens: 4096,
        },
      },
    }));

    assert.equal(config.port, 9090);
    assert.equal(config.debug, true);
    assert.deepEqual(config.routes.default, { provider: 'provider-a' });
    assert.equal(config.pools['sonnet-primary'].strategy, 'priority-fallback');
    assert.equal(config.loadBalancer.showProvider, true);
    assert.equal(config.providers['provider-a'].model, 'actual-model');
    assert.equal(config.providers['provider-a'].baseURL, 'https://api.example.com/v1');
    assert.equal(config.providers['provider-a'].apiKey, 'sk-test');
    assert.equal(config.providers['provider-a'].maxTokens, 4096);
  });

  it('should use defaults for missing fields', () => {
    const config = parseConfig(JSON.stringify({}));
    assert.equal(config.port, 8082);
    assert.equal(config.debug, false);
    assert.deepEqual(config.routes, {});
    assert.deepEqual(config.pools, {});
    assert.deepEqual(config.providers, {});
  });

  it('should use provider ID as model when model is not provided', () => {
    const config = parseConfig(JSON.stringify({
      providers: {
        'my-provider': { baseURL: 'https://api.example.com', apiKey: 'key' },
      },
    }));
    assert.equal(config.providers['my-provider'].model, 'my-provider');
  });

  it('should resolve env vars in provider config', () => {
    process.env.MY_TEST_API_KEY = 'secret-key';
    process.env.MY_TEST_BASE_URL = 'https://custom.api.com';
    const config = parseConfig(JSON.stringify({
      providers: {
        test: {
          baseURL: '${MY_TEST_BASE_URL}',
          apiKey: '$MY_TEST_API_KEY',
        },
      },
    }));

    assert.equal(config.providers.test.baseURL, 'https://custom.api.com');
    assert.equal(config.providers.test.apiKey, 'secret-key');
    delete process.env.MY_TEST_API_KEY;
    delete process.env.MY_TEST_BASE_URL;
  });

  it('should set maxTokens to null when not provided', () => {
    const config = parseConfig(JSON.stringify({
      providers: {
        test: { baseURL: 'https://api.example.com', apiKey: 'key' },
      },
    }));
    assert.equal(config.providers.test.maxTokens, null);
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
      providers: { p1: { model: 'm1', baseURL: 'http://localhost', apiKey: 'k' } },
    }));

    const raw = readFileSync(configPath, 'utf8');
    const config = parseConfig(raw);
    assert.equal(config.port, 3000);
    assert.ok(config.providers.p1);
  });
});
