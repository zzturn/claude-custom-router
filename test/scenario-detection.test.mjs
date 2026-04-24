import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_FAMILIES, detectExplicitModel, detectModelFamily, detectImage,
} from '../src/detectors.mjs';

/**
 * Creates a mock detection context with the given route config and providers.
 */
function createCtx(routeOverrides = {}, providers = {}) {
  return {
    tokenCount: 1000,
    config: {
      routes: {
        default: { provider: 'default-provider' },
        image: { provider: 'vision-provider' },
        haiku: { provider: 'haiku-provider' },
        sonnet: { provider: 'sonnet-provider' },
        opus: { provider: 'opus-provider' },
        ...routeOverrides,
      },
      providers,
    },
  };
}

// ─── detectExplicitModel ──────────────────────────────────────────────────────

describe('detectExplicitModel', () => {
  it('should detect comma-separated model ID', () => {
    const body = { model: 'original,my-model' };
    const ctx = createCtx({}, { 'my-model': { model: 'my-model' } });
    assert.equal(detectExplicitModel(body, ctx), 'my-model');
  });

  it('should return full comma-separated string if it matches a model ID', () => {
    const body = { model: 'a,b' };
    const ctx = createCtx({}, { 'a,b': { model: 'combined' } });
    assert.equal(detectExplicitModel(body, ctx), 'a,b');
  });

  it('should return afterComma if no direct match', () => {
    const body = { model: 'x,y,z' };
    const ctx = createCtx({}, { 'y,z': { model: 'yz' } });
    assert.equal(detectExplicitModel(body, ctx), 'y,z');
  });

  it('should return null when no comma in model', () => {
    const body = { model: 'plain-model' };
    const ctx = createCtx();
    assert.equal(detectExplicitModel(body, ctx), null);
  });

  it('should return null when model is undefined', () => {
    const body = {};
    const ctx = createCtx();
    assert.equal(detectExplicitModel(body, ctx), null);
  });
});

// ─── detectModelFamily ────────────────────────────────────────────────────────

describe('detectModelFamily', () => {
  it('should map sonnet model ID to sonnet key', () => {
    assert.equal(
      detectModelFamily({ model: 'claude-sonnet-4-6' }, createCtx()),
      'sonnet'
    );
  });

  it('should map haiku model ID to haiku key', () => {
    assert.equal(
      detectModelFamily({ model: 'claude-haiku-4-5' }, createCtx()),
      'haiku'
    );
  });

  it('should map opus model ID to opus key', () => {
    assert.equal(
      detectModelFamily({ model: 'claude-opus-4-6' }, createCtx()),
      'opus'
    );
  });

  it('should return null for unknown model IDs', () => {
    assert.equal(
      detectModelFamily({ model: 'claude-unknown-model' }, createCtx()),
      null
    );
  });

  it('should return null when no model family configured', () => {
    const ctx = createCtx({ haiku: undefined, sonnet: undefined, opus: undefined });
    assert.equal(
      detectModelFamily({ model: 'claude-sonnet-4-6' }, ctx),
      null
    );
  });

  it('should return null when body.model is undefined', () => {
    assert.equal(detectModelFamily({}, createCtx()), null);
  });

  it('should return null when body.model is empty string', () => {
    assert.equal(detectModelFamily({ model: '' }, createCtx()), null);
  });

  it('should prefer opus over sonnet when model ID contains both', () => {
    assert.equal(
      detectModelFamily({ model: 'claude-opus-sonnet-4-6' }, createCtx()),
      'opus'
    );
  });
});

// ─── detectImage ──────────────────────────────────────────────────────────────

describe('detectImage', () => {
  it('should detect image content in messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: [{ type: 'image', source: {} }] },
      ],
    };
    assert.equal(detectImage(body, createCtx()), 'image');
  });

  it('should detect image_url type', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', url: 'https://example.com/img.png' }] },
      ],
    };
    assert.equal(detectImage(body, createCtx()), 'image');
  });

  it('should return null for text-only messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Just text' },
      ],
    };
    assert.equal(detectImage(body, createCtx()), null);
  });

  it('should return null when no image model configured', () => {
    const ctx = createCtx({ image: undefined });
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image', source: {} }] },
      ],
    };
    assert.equal(detectImage(body, ctx), null);
  });
});
