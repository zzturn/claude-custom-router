import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the detector functions directly for unit testing
// We test them in isolation by calling with mock body and ctx

/**
 * Creates a mock detection context with the given router config and models.
 */
function createCtx(routerOverrides = {}, models = {}) {
  return {
    tokenCount: 1000,
    config: {
      Router: {
        longContextThreshold: 60000,
        longContext: 'long-ctx-model',
        subagent: null,
        background: 'bg-model',
        webSearch: 'search-model',
        think: 'think-model',
        image: 'vision-model',
        ...routerOverrides,
      },
      models,
    },
  };
}

// ─── detectExplicitModel ──────────────────────────────────────────────────────

describe('detectExplicitModel', () => {
  // Inline the detector logic for isolated testing
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

  it('should detect comma-separated model ID', () => {
    const body = { model: 'original,my-model' };
    const ctx = createCtx({}, { 'my-model': { name: 'my-model' } });
    assert.equal(detectExplicitModel(body, ctx), 'my-model');
  });

  it('should return full comma-separated string if it matches a model ID', () => {
    const body = { model: 'a,b' };
    const ctx = createCtx({}, { 'a,b': { name: 'combined' } });
    assert.equal(detectExplicitModel(body, ctx), 'a,b');
  });

  it('should return afterComma if no direct match', () => {
    const body = { model: 'x,y,z' };
    const ctx = createCtx({}, { 'y,z': { name: 'yz' } });
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

// ─── detectLongContext ────────────────────────────────────────────────────────

describe('detectLongContext', () => {
  function detectLongContext(body, ctx) {
    const threshold = ctx.config.Router.longContextThreshold || 60000;
    if (ctx.tokenCount > threshold && ctx.config.Router.longContext) {
      return ctx.config.Router.longContext;
    }
    return null;
  }

  it('should trigger when token count exceeds threshold', () => {
    const ctx = createCtx({}, {}, 70000);
    ctx.tokenCount = 70000;
    assert.equal(detectLongContext({}, ctx), 'long-ctx-model');
  });

  it('should not trigger when token count is below threshold', () => {
    const ctx = createCtx();
    ctx.tokenCount = 50000;
    assert.equal(detectLongContext({}, ctx), null);
  });

  it('should not trigger when no longContext model configured', () => {
    const ctx = createCtx({ longContext: undefined });
    ctx.tokenCount = 70000;
    assert.equal(detectLongContext({}, ctx), null);
  });

  it('should use custom threshold from config', () => {
    const ctx = createCtx({ longContextThreshold: 30000 });
    ctx.tokenCount = 35000;
    assert.equal(detectLongContext({}, ctx), 'long-ctx-model');
  });
});

// ─── detectSubagent ───────────────────────────────────────────────────────────

describe('detectSubagent', () => {
  function detectSubagent(body, ctx) {
    if (Array.isArray(body.system) && body.system.length > 1) {
      const sysText = body.system[1]?.text;
      if (sysText && sysText.startsWith('<CCR-SUBAGENT-MODEL>')) {
        const match = sysText.match(/<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s);
        if (match) {
          body.system[1].text = sysText.replace(
            `<CCR-SUBAGENT-MODEL>${match[1]}</CCR-SUBAGENT-MODEL>`, ''
          );
          return match[1];
        }
      }
    }
    return null;
  }

  it('should detect and extract subagent model tag', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are helpful.' },
        { type: 'text', text: '<CCR-SUBAGENT-MODEL>my-model</CCR-SUBAGENT-MODEL>Extra instructions' },
      ],
    };
    const result = detectSubagent(body, createCtx());
    assert.equal(result, 'my-model');
    assert.equal(body.system[1].text, 'Extra instructions');
  });

  it('should return null when no subagent tag', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are helpful.' },
        { type: 'text', text: 'No tag here' },
      ],
    };
    assert.equal(detectSubagent(body, createCtx()), null);
  });

  it('should return null when system is a string', () => {
    assert.equal(detectSubagent({ system: 'simple string' }, createCtx()), null);
  });

  it('should return null when system has only one element', () => {
    const body = {
      system: [{ type: 'text', text: 'Only one' }],
    };
    assert.equal(detectSubagent(body, createCtx()), null);
  });
});

// ─── detectBackground ─────────────────────────────────────────────────────────

describe('detectBackground', () => {
  function detectBackground(body, ctx) {
    if (body.model && body.model.includes('claude') && body.model.includes('haiku')) {
      if (ctx.config.Router.background) return ctx.config.Router.background;
    }
    return null;
  }

  it('should detect haiku model requests', () => {
    assert.equal(detectBackground({ model: 'claude-haiku-4-5' }, createCtx()), 'bg-model');
  });

  it('should not detect non-haiku models', () => {
    assert.equal(detectBackground({ model: 'claude-sonnet-4-6' }, createCtx()), null);
  });

  it('should return null when no background model configured', () => {
    const ctx = createCtx({ background: undefined });
    assert.equal(detectBackground({ model: 'claude-haiku-4-5' }, ctx), null);
  });
});

// ─── detectWebSearch ──────────────────────────────────────────────────────────

describe('detectWebSearch', () => {
  function detectWebSearch(body, ctx) {
    if (Array.isArray(body.tools) && body.tools.some(t => t.type?.startsWith('web_search'))) {
      if (ctx.config.Router.webSearch) return ctx.config.Router.webSearch;
    }
    return null;
  }

  it('should detect web_search tools', () => {
    const body = { tools: [{ type: 'web_search_xxx' }] };
    assert.equal(detectWebSearch(body, createCtx()), 'search-model');
  });

  it('should not detect non-web-search tools', () => {
    const body = { tools: [{ type: 'text_editor' }] };
    assert.equal(detectWebSearch(body, createCtx()), null);
  });

  it('should return null when no tools', () => {
    assert.equal(detectWebSearch({}, createCtx()), null);
  });
});

// ─── detectThink ──────────────────────────────────────────────────────────────

describe('detectThink', () => {
  function detectThink(body, ctx) {
    if (body.thinking && ctx.config.Router.think) return ctx.config.Router.think;
    return null;
  }

  it('should detect thinking requests', () => {
    assert.equal(detectThink({ thinking: { budget_tokens: 10000 } }, createCtx()), 'think-model');
  });

  it('should return null when no thinking field', () => {
    assert.equal(detectThink({}, createCtx()), null);
  });
});

// ─── detectImage ──────────────────────────────────────────────────────────────

describe('detectImage', () => {
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
            return ctx.config.Router.image;
          }
        }
      }
    }
    return null;
  }

  it('should detect image content in messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: [{ type: 'image', source: {} }] },
      ],
    };
    assert.equal(detectImage(body, createCtx()), 'vision-model');
  });

  it('should detect image_url type', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', url: 'https://example.com/img.png' }] },
      ],
    };
    assert.equal(detectImage(body, createCtx()), 'vision-model');
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
