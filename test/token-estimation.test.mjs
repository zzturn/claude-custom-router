import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline the token estimation function for isolated testing
const TOKEN_CHAR_RATIO = 4;

function estimateTokenCount(body) {
  let charCount = 0;
  const { messages = [], system, tools = [] } = body;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) charCount += part.text.length;
        else if (part.type === 'tool_result') {
          const c = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          charCount += c.length;
        }
      }
    }
  }

  if (typeof system === 'string') charCount += system.length;
  else if (Array.isArray(system)) {
    for (const item of system) {
      if (item.type === 'text') {
        if (typeof item.text === 'string') charCount += item.text.length;
        else if (Array.isArray(item.text)) {
          for (const t of item.text) charCount += (t || '').length;
        }
      }
    }
  }

  for (const tool of tools) {
    if (tool.description) charCount += tool.description.length;
    if (tool.input_schema) charCount += JSON.stringify(tool.input_schema).length;
  }

  return Math.ceil(charCount / TOKEN_CHAR_RATIO);
}

describe('estimateTokenCount', () => {
  it('should estimate tokens from simple string messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello world' },  // 11 chars
        { role: 'assistant', content: 'Hi there' }, // 8 chars
      ],
    };
    const result = estimateTokenCount(body);
    assert.equal(result, Math.ceil(19 / TOKEN_CHAR_RATIO));
  });

  it('should handle empty body', () => {
    assert.equal(estimateTokenCount({}), 0);
    assert.equal(estimateTokenCount({ messages: [] }), 0);
  });

  it('should count text parts in array content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image', source: {} },
          ],
        },
      ],
    };
    // Only 'Hello' = 5 chars
    assert.equal(estimateTokenCount(body), Math.ceil(5 / TOKEN_CHAR_RATIO));
  });

  it('should count tool_result content as string', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'result text' },
          ],
        },
      ],
    };
    assert.equal(estimateTokenCount(body), Math.ceil(11 / TOKEN_CHAR_RATIO));
  });

  it('should count tool_result with array content via JSON.stringify', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: [{ type: 'text', text: 'nested' }] },
          ],
        },
      ],
    };
    const expected = JSON.stringify([{ type: 'text', text: 'nested' }]).length;
    assert.equal(estimateTokenCount(body), Math.ceil(expected / TOKEN_CHAR_RATIO));
  });

  it('should count string system prompt', () => {
    const body = {
      system: 'You are a helpful assistant.',
      messages: [],
    };
    const result = estimateTokenCount(body);
    assert.equal(result, Math.ceil(28 / TOKEN_CHAR_RATIO));
  });

  it('should count array system prompt with text items', () => {
    const body = {
      system: [
        { type: 'text', text: 'System prompt' },
      ],
      messages: [],
    };
    assert.equal(estimateTokenCount(body), Math.ceil(13 / TOKEN_CHAR_RATIO));
  });

  it('should count array system prompt with nested text array', () => {
    const body = {
      system: [
        { type: 'text', text: ['Line 1', 'Line 2'] },
      ],
      messages: [],
    };
    // 'Line 1' (6) + 'Line 2' (6) = 12 chars
    assert.equal(estimateTokenCount(body), Math.ceil(12 / TOKEN_CHAR_RATIO));
  });

  it('should count tool descriptions and schemas', () => {
    const body = {
      messages: [],
      tools: [
        {
          name: 'Read',
          description: 'Read a file from the filesystem.',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    };
    const descLen = 'Read a file from the filesystem.'.length;
    const schemaLen = JSON.stringify(body.tools[0].input_schema).length;
    assert.equal(estimateTokenCount(body), Math.ceil((descLen + schemaLen) / TOKEN_CHAR_RATIO));
  });

  it('should combine all sources', () => {
    const body = {
      system: 'System',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      tools: [
        { description: 'A tool', input_schema: { type: 'object' } },
      ],
    };
    const total = 'System'.length + 'Hello'.length + 'A tool'.length + JSON.stringify({ type: 'object' }).length;
    assert.equal(estimateTokenCount(body), Math.ceil(total / TOKEN_CHAR_RATIO));
  });
});
