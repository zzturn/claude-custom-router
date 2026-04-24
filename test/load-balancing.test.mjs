import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  strategies, activeConns, getConns, selectProvider, withConnTracking,
} from '../src/load-balancer.mjs';

const noopLogger = { warn: () => {} };

// ─── Strategy Tests ────────────────────────────────────────────────────────

describe('priority-fallback strategy', () => {
  const priorityFallback = strategies['priority-fallback'];
  const makeCtx = (connsMap) => ({ getConns: (id) => connsMap[id] || 0 });

  it('should select first provider with available capacity', () => {
    const providers = [
      { provider: 'primary', maxConns: 5 },
      { provider: 'backup', maxConns: 3 },
    ];
    const ctx = makeCtx({ primary: 3, backup: 0 });
    assert.equal(priorityFallback(providers, ctx), 'primary');
  });

  it('should overflow to second provider when primary is full', () => {
    const providers = [
      { provider: 'primary', maxConns: 5 },
      { provider: 'backup', maxConns: 3 },
    ];
    const ctx = makeCtx({ primary: 5, backup: 1 });
    assert.equal(priorityFallback(providers, ctx), 'backup');
  });

  it('should fail-open to first provider when all full', () => {
    const providers = [
      { provider: 'primary', maxConns: 2 },
      { provider: 'backup', maxConns: 1 },
    ];
    const ctx = makeCtx({ primary: 2, backup: 1 });
    assert.equal(priorityFallback(providers, ctx), 'primary');
  });

  it('should return null for empty providers array', () => {
    assert.equal(priorityFallback([], makeCtx({})), null);
  });

  it('should return null for null providers', () => {
    assert.equal(priorityFallback(null, makeCtx({})), null);
  });

  it('should select first provider when all have zero connections', () => {
    const providers = [
      { provider: 'a', maxConns: 3 },
      { provider: 'b', maxConns: 3 },
    ];
    assert.equal(priorityFallback(providers, makeCtx({})), 'a');
  });

  it('should handle single provider', () => {
    const providers = [{ provider: 'solo', maxConns: 2 }];
    const ctx = makeCtx({ solo: 1 });
    assert.equal(priorityFallback(providers, ctx), 'solo');
  });

  it('should overflow through multiple providers', () => {
    const providers = [
      { provider: 'p1', maxConns: 1 },
      { provider: 'p2', maxConns: 1 },
      { provider: 'p3', maxConns: 1 },
    ];
    const ctx = makeCtx({ p1: 1, p2: 1, p3: 0 });
    assert.equal(priorityFallback(providers, ctx), 'p3');
  });
});

// ─── Connection Tracking Tests ─────────────────────────────────────────────

describe('withConnTracking', () => {
  beforeEach(() => { activeConns.clear(); });

  it('should increment connection count on creation', () => {
    withConnTracking('test-provider');
    assert.equal(getConns('test-provider'), 1);
  });

  it('should decrement connection count on cleanup', () => {
    const tracker = withConnTracking('test-provider');
    tracker.cleanup();
    assert.equal(getConns('test-provider'), 0);
  });

  it('should handle multiple connections for same provider', () => {
    const t1 = withConnTracking('multi');
    const t2 = withConnTracking('multi');
    assert.equal(getConns('multi'), 2);
    t1.cleanup();
    assert.equal(getConns('multi'), 1);
    t2.cleanup();
    assert.equal(getConns('multi'), 0);
  });

  it('should not decrement below zero (once-guard)', () => {
    const tracker = withConnTracking('guarded');
    tracker.cleanup();
    tracker.cleanup();
    tracker.cleanup();
    assert.equal(getConns('guarded'), 0);
  });

  it('should expose providerId', () => {
    const tracker = withConnTracking('my-provider');
    assert.equal(tracker.providerId, 'my-provider');
  });
});

describe('cross-pool provider capacity', () => {
  beforeEach(() => { activeConns.clear(); });

  it('should share activeConns across pools when they reuse the same provider ID', () => {
    const haikuPool = {
      strategy: 'priority-fallback',
      providers: [
        { provider: 'glm', maxConns: 1 },
        { provider: 'haiku-backup', maxConns: 2 },
      ],
    };
    const sonnetPool = {
      strategy: 'priority-fallback',
      providers: [
        { provider: 'glm', maxConns: 1 },
        { provider: 'sonnet-backup', maxConns: 2 },
      ],
    };

    const pickedForHaiku = selectProvider('haiku-primary', haikuPool, noopLogger);
    assert.equal(pickedForHaiku, 'glm');

    const tracker = withConnTracking(pickedForHaiku);
    assert.equal(getConns('glm'), 1);

    const pickedForSonnet = selectProvider('sonnet-primary', sonnetPool, noopLogger);
    assert.equal(pickedForSonnet, 'sonnet-backup');

    tracker.cleanup();
  });

  it('should keep capacities isolated when pools use different provider IDs', () => {
    const haikuPool = {
      strategy: 'priority-fallback',
      providers: [
        { provider: 'glm', maxConns: 1 },
        { provider: 'haiku-backup', maxConns: 2 },
      ],
    };
    const sonnetPool = {
      strategy: 'priority-fallback',
      providers: [
        { provider: 'zai_glm', maxConns: 1 },
        { provider: 'sonnet-backup', maxConns: 2 },
      ],
    };

    const tracker = withConnTracking('glm');
    assert.equal(getConns('glm'), 1);
    assert.equal(getConns('zai_glm'), 0);

    const pickedForSonnet = selectProvider('sonnet-primary', sonnetPool, noopLogger);
    assert.equal(pickedForSonnet, 'zai_glm');

    tracker.cleanup();
  });
});

// ─── Config Validation Tests ───────────────────────────────────────────────

describe('LB config validation', () => {
  function validateConfig(config) {
    const errors = [];
    const providers = config.providers || {};
    const pools = config.pools || {};
    const routes = config.routes || {};
    const knownStrategies = Object.keys(strategies);

    for (const providerId of Object.keys(providers)) {
      if (providerId in routes) errors.push(`collision: provider "${providerId}" == route key`);
      if (providerId in pools) errors.push(`collision: provider "${providerId}" == pool key`);
    }

    for (const poolId of Object.keys(pools)) {
      if (poolId in routes) errors.push(`collision: pool "${poolId}" == route key`);
    }

    for (const [poolId, pool] of Object.entries(pools)) {
      if (!pool.strategy) errors.push(`pool "${poolId}" missing strategy`);
      if (!knownStrategies.includes(pool.strategy)) {
        errors.push(`pool "${poolId}" unknown strategy "${pool.strategy}"`);
      }
      if (!Array.isArray(pool.providers) || pool.providers.length === 0) {
        errors.push(`pool "${poolId}" empty providers`);
      }
      if (Array.isArray(pool.providers)) {
        const seenProviders = new Set();
        for (const providerRef of pool.providers) {
          if (!providerRef.provider) errors.push(`pool "${poolId}" provider missing provider`);
          if (!providers[providerRef.provider]) errors.push(`pool "${poolId}" unknown provider "${providerRef.provider}"`);
          if (seenProviders.has(providerRef.provider)) errors.push(`pool "${poolId}" duplicate "${providerRef.provider}"`);
          seenProviders.add(providerRef.provider);
          if (!Number.isInteger(providerRef.maxConns) || providerRef.maxConns < 1) {
            errors.push(`pool "${poolId}" invalid maxConns for "${providerRef.provider}"`);
          }
        }
      }
    }

    for (const [routeId, route] of Object.entries(routes)) {
      const hasProvider = typeof route?.provider === 'string';
      const hasPool = typeof route?.pool === 'string';
      if (hasProvider === hasPool) errors.push(`route "${routeId}" invalid target`);
      if (hasProvider && !providers[route.provider]) errors.push(`route "${routeId}" unknown provider "${route.provider}"`);
      if (hasPool && !pools[route.pool]) errors.push(`route "${routeId}" unknown pool "${route.pool}"`);
    }

    return errors;
  }

  it('should pass for valid LB config', () => {
    const errors = validateConfig({
      providers: { 'ds-sonnet': { model: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      pools: {
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [{ provider: 'ds-sonnet', maxConns: 5 }],
        },
      },
      routes: {
        sonnet: { pool: 'sonnet-primary' },
      },
    });
    assert.equal(errors.length, 0);
  });

  it('should reject provider ID colliding with route key', () => {
    const errors = validateConfig({
      providers: { sonnet: { model: 's', baseURL: 'https://a', apiKey: 'k' } },
      routes: { sonnet: { provider: 'sonnet' } },
    });
    assert.ok(errors.some(e => e.includes('collision')));
  });

  it('should reject pool with unknown provider', () => {
    const errors = validateConfig({
      providers: {},
      pools: {
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [{ provider: 'nonexistent', maxConns: 3 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('unknown provider')));
  });

  it('should reject pool with duplicate provider', () => {
    const errors = validateConfig({
      providers: {
        ds: { model: 'ds', baseURL: 'https://a', apiKey: 'k' },
      },
      pools: {
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [
            { provider: 'ds', maxConns: 3 },
            { provider: 'ds', maxConns: 5 },
          ],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('should allow the same provider ID to appear in multiple pools', () => {
    const errors = validateConfig({
      providers: {
        glm: { model: 'glm-4', baseURL: 'https://a', apiKey: 'k' },
        backup: { model: 'backup', baseURL: 'https://b', apiKey: 'k' },
      },
      pools: {
        'haiku-primary': {
          strategy: 'priority-fallback',
          providers: [
            { provider: 'glm', maxConns: 2 },
            { provider: 'backup', maxConns: 1 },
          ],
        },
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [
            { provider: 'glm', maxConns: 2 },
          ],
        },
      },
      routes: {
        haiku: { pool: 'haiku-primary' },
        sonnet: { pool: 'sonnet-primary' },
      },
    });
    assert.equal(errors.length, 0);
  });

  it('should reject route with unknown provider', () => {
    const errors = validateConfig({
      providers: {},
      routes: {
        default: { provider: 'missing' },
      },
    });
    assert.ok(errors.some(e => e.includes('unknown provider')));
  });

  it('should reject route with unknown pool', () => {
    const errors = validateConfig({
      providers: {},
      pools: {},
      routes: {
        sonnet: { pool: 'missing-pool' },
      },
    });
    assert.ok(errors.some(e => e.includes('unknown pool')));
  });

  it('should reject route declaring both provider and pool', () => {
    const errors = validateConfig({
      providers: { glm: { model: 'glm', baseURL: 'https://a', apiKey: 'k' } },
      pools: { p1: { strategy: 'priority-fallback', providers: [{ provider: 'glm', maxConns: 1 }] } },
      routes: {
        default: { provider: 'glm', pool: 'p1' },
      },
    });
    assert.ok(errors.some(e => e.includes('invalid target')));
  });

  it('should reject pool with invalid maxConns', () => {
    const errors = validateConfig({
      providers: { ds: { model: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      pools: {
        'sonnet-primary': {
          strategy: 'priority-fallback',
          providers: [{ provider: 'ds', maxConns: 0 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('invalid maxConns')));
  });

  it('should reject pool with missing strategy', () => {
    const errors = validateConfig({
      providers: { ds: { model: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      pools: {
        'sonnet-primary': {
          providers: [{ provider: 'ds', maxConns: 3 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('missing strategy')));
  });

  it('should reject pool with empty providers', () => {
    const errors = validateConfig({
      providers: {},
      pools: {
        'sonnet-primary': { strategy: 'priority-fallback', providers: [] },
      },
    });
    assert.ok(errors.some(e => e.includes('empty providers')));
  });

  it('should reject pool with unknown strategy', () => {
    const errors = validateConfig({
      providers: { ds: { model: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      pools: {
        'sonnet-primary': {
          strategy: 'round-robin',
          providers: [{ provider: 'ds', maxConns: 3 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('unknown strategy')));
  });
});

// ─── SSE Injection Double-Gate Tests ───────────────────────────────────────

describe('SSE injection double-gate', () => {
  function shouldInjectSSE(parsed, contentType, showProvider) {
    return showProvider && parsed.stream === true && contentType.includes('text/event-stream');
  }

  it('should inject when stream=true AND content-type is SSE', () => {
    assert.equal(shouldInjectSSE({ stream: true }, 'text/event-stream', true), true);
  });

  it('should NOT inject when stream is false', () => {
    assert.equal(shouldInjectSSE({ stream: false }, 'text/event-stream', true), false);
  });

  it('should NOT inject when stream is undefined', () => {
    assert.equal(shouldInjectSSE({}, 'text/event-stream', true), false);
  });

  it('should NOT inject when content-type is not SSE', () => {
    assert.equal(shouldInjectSSE({ stream: true }, 'application/json', true), false);
  });

  it('should NOT inject when showProvider is false', () => {
    assert.equal(shouldInjectSSE({ stream: true }, 'text/event-stream', false), false);
  });

  it('should inject for content-type with charset', () => {
    assert.equal(shouldInjectSSE({ stream: true }, 'text/event-stream; charset=utf-8', true), true);
  });
});
