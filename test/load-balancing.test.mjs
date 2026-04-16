import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  strategies, activeConns, getConns, withConnTracking,
} from '../src/load-balancer.mjs';

// ─── Strategy Tests ────────────────────────────────────────────────────────

describe('priority-fallback strategy', () => {
  const priorityFallback = strategies['priority-fallback'];
  const makeCtx = (connsMap) => ({ getConns: (id) => connsMap[id] || 0 });

  it('should select first provider with available capacity', () => {
    const providers = [
      { id: 'primary', maxConns: 5 },
      { id: 'backup', maxConns: 3 },
    ];
    const ctx = makeCtx({ primary: 3, backup: 0 });
    assert.equal(priorityFallback(providers, ctx), 'primary');
  });

  it('should overflow to second provider when primary is full', () => {
    const providers = [
      { id: 'primary', maxConns: 5 },
      { id: 'backup', maxConns: 3 },
    ];
    const ctx = makeCtx({ primary: 5, backup: 1 });
    assert.equal(priorityFallback(providers, ctx), 'backup');
  });

  it('should fail-open to first provider when all full', () => {
    const providers = [
      { id: 'primary', maxConns: 2 },
      { id: 'backup', maxConns: 1 },
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
      { id: 'a', maxConns: 3 },
      { id: 'b', maxConns: 3 },
    ];
    assert.equal(priorityFallback(providers, makeCtx({})), 'a');
  });

  it('should handle single provider', () => {
    const providers = [{ id: 'solo', maxConns: 2 }];
    const ctx = makeCtx({ solo: 1 });
    assert.equal(priorityFallback(providers, ctx), 'solo');
  });

  it('should overflow through multiple providers', () => {
    const providers = [
      { id: 'p1', maxConns: 1 },
      { id: 'p2', maxConns: 1 },
      { id: 'p3', maxConns: 1 },
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

// ─── Config Validation Tests ───────────────────────────────────────────────

describe('LB config validation', () => {
  function validateConfig(config) {
    const errors = [];
    const models = config.models || {};
    const router = config.Router || {};
    const knownStrategies = Object.keys(strategies);

    // Check collision: model ID == Router key
    for (const modelId of Object.keys(models)) {
      if (modelId in router) {
        errors.push(`collision: model "${modelId}" == Router key`);
      }
    }

    // Validate LB groups
    for (const [key, entry] of Object.entries(router)) {
      if (typeof entry === 'object' && entry !== null) {
        if (!entry.strategy) errors.push(`group "${key}" missing strategy`);
        if (!knownStrategies.includes(entry.strategy)) {
          errors.push(`group "${key}" unknown strategy "${entry.strategy}"`);
        }
        if (!Array.isArray(entry.providers) || entry.providers.length === 0) {
          errors.push(`group "${key}" empty providers`);
        }
        if (Array.isArray(entry.providers)) {
          const seenIds = new Set();
          for (const p of entry.providers) {
            if (!p.id) errors.push(`group "${key}" provider missing id`);
            if (!models[p.id]) errors.push(`group "${key}" unknown model "${p.id}"`);
            if (seenIds.has(p.id)) errors.push(`group "${key}" duplicate "${p.id}"`);
            seenIds.add(p.id);
            if (!Number.isInteger(p.maxConns) || p.maxConns < 1) {
              errors.push(`group "${key}" invalid maxConns for "${p.id}"`);
            }
          }
        }
      }
    }

    return errors;
  }

  it('should pass for valid LB config', () => {
    const errors = validateConfig({
      models: { 'ds-sonnet': { name: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      Router: {
        sonnet: {
          strategy: 'priority-fallback',
          providers: [{ id: 'ds-sonnet', maxConns: 5 }],
        },
      },
    });
    assert.equal(errors.length, 0);
  });

  it('should reject model ID colliding with Router key', () => {
    const errors = validateConfig({
      models: { 'sonnet': { name: 's', baseURL: 'https://a', apiKey: 'k' } },
      Router: { 'sonnet': 'sonnet' },
    });
    assert.ok(errors.some(e => e.includes('collision')));
  });

  it('should reject LB group with unknown provider', () => {
    const errors = validateConfig({
      models: {},
      Router: {
        sonnet: {
          strategy: 'priority-fallback',
          providers: [{ id: 'nonexistent', maxConns: 3 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('unknown model')));
  });

  it('should reject LB group with duplicate provider', () => {
    const errors = validateConfig({
      models: {
        'ds': { name: 'ds', baseURL: 'https://a', apiKey: 'k' },
      },
      Router: {
        sonnet: {
          strategy: 'priority-fallback',
          providers: [
            { id: 'ds', maxConns: 3 },
            { id: 'ds', maxConns: 5 },
          ],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('should reject LB group with invalid maxConns', () => {
    const errors = validateConfig({
      models: { 'ds': { name: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      Router: {
        sonnet: {
          strategy: 'priority-fallback',
          providers: [{ id: 'ds', maxConns: 0 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('invalid maxConns')));
  });

  it('should reject LB group with missing strategy', () => {
    const errors = validateConfig({
      models: { 'ds': { name: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      Router: {
        sonnet: {
          providers: [{ id: 'ds', maxConns: 3 }],
        },
      },
    });
    assert.ok(errors.some(e => e.includes('missing strategy')));
  });

  it('should reject LB group with empty providers', () => {
    const errors = validateConfig({
      models: {},
      Router: {
        sonnet: { strategy: 'priority-fallback', providers: [] },
      },
    });
    assert.ok(errors.some(e => e.includes('empty providers')));
  });

  it('should pass for string Router values (backward compat)', () => {
    const errors = validateConfig({
      models: { 'glm': { name: 'glm', baseURL: 'https://a', apiKey: 'k' } },
      Router: { default: 'glm', haiku: 'glm' },
    });
    assert.equal(errors.length, 0);
  });

  it('should reject LB group with unknown strategy', () => {
    const errors = validateConfig({
      models: { 'ds': { name: 'ds', baseURL: 'https://a', apiKey: 'k' } },
      Router: {
        sonnet: {
          strategy: 'round-robin',
          providers: [{ id: 'ds', maxConns: 3 }],
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
