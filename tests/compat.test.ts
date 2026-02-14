import { describe, it, expect } from 'bun:test';
import {
  parseMessagesRequest,
  formatMessagesResponse,
  formatErrorResponse,
  formatStreamingResponse,
  mapModelId,
  type MessagesRequest,
} from '../src/compat';
import type { ProxyResponse } from '../src/types';

// ============================================================================
// Model ID mapping
// ============================================================================

describe('mapModelId', () => {
  it('maps full opus model ID to short name', () => {
    expect(mapModelId('claude-opus-4-6')).toBe('opus');
    expect(mapModelId('claude-opus-4-20250916')).toBe('opus');
  });

  it('maps full sonnet model ID to short name', () => {
    expect(mapModelId('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(mapModelId('claude-sonnet-4-5-20241022')).toBe('sonnet');
  });

  it('maps full haiku model ID to short name', () => {
    expect(mapModelId('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('maps unknown claude-* patterns via prefix', () => {
    expect(mapModelId('claude-opus-5-20260101')).toBe('opus');
    expect(mapModelId('claude-sonnet-5-20260101')).toBe('sonnet');
    expect(mapModelId('claude-haiku-5-20260101')).toBe('haiku');
  });

  it('passes through short names unchanged', () => {
    expect(mapModelId('opus')).toBe('opus');
    expect(mapModelId('sonnet')).toBe('sonnet');
    expect(mapModelId('haiku')).toBe('haiku');
  });

  it('passes through unknown model names unchanged', () => {
    expect(mapModelId('gpt-4o')).toBe('gpt-4o');
    expect(mapModelId('custom-model')).toBe('custom-model');
  });
});

// ============================================================================
// Request parsing
// ============================================================================

describe('parseMessagesRequest', () => {
  it('handles single user message', () => {
    const req: MessagesRequest = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello world' }],
    };
    const result = parseMessagesRequest(req);
    expect('error' in result).toBe(false);
    if ('proxyReq' in result) {
      expect(result.proxyReq.prompt).toBe('Hello world');
      expect(result.proxyReq.model).toBe('sonnet');
      expect(result.stream).toBe(false);
    }
  });

  it('handles multi-turn conversation', () => {
    const req: MessagesRequest = {
      model: 'opus',
      max_tokens: 200,
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'And 3+3?' },
      ],
    };
    const result = parseMessagesRequest(req);
    expect('proxyReq' in result).toBe(true);
    if ('proxyReq' in result) {
      expect(result.proxyReq.prompt).toBe('Human: What is 2+2?\n\nAssistant: 4\n\nHuman: And 3+3?');
    }
  });

  it('handles content block arrays (text only)', () => {
    const req: MessagesRequest = {
      model: 'haiku',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'First paragraph.' },
          { type: 'text', text: 'Second paragraph.' },
        ],
      }],
    };
    const result = parseMessagesRequest(req);
    expect('proxyReq' in result).toBe(true);
    if ('proxyReq' in result) {
      expect(result.proxyReq.prompt).toBe('First paragraph.\nSecond paragraph.');
    }
  });

  it('rejects image content blocks', () => {
    const req: MessagesRequest = {
      model: 'sonnet',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', data: '...' } },
        ],
      }],
    };
    const result = parseMessagesRequest(req);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Image content blocks are not supported');
    }
  });

  it('includes system prompt when provided', () => {
    const req: MessagesRequest = {
      model: 'sonnet',
      max_tokens: 100,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const result = parseMessagesRequest(req);
    expect('proxyReq' in result).toBe(true);
    if ('proxyReq' in result) {
      expect(result.proxyReq.systemPrompt).toBe('You are a helpful assistant.');
    }
  });

  it('detects stream flag', () => {
    const req: MessagesRequest = {
      model: 'sonnet',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const result = parseMessagesRequest(req);
    expect('proxyReq' in result).toBe(true);
    if ('proxyReq' in result) {
      expect(result.stream).toBe(true);
    }
  });

  it('rejects empty messages array', () => {
    const req: MessagesRequest = {
      model: 'sonnet',
      max_tokens: 100,
      messages: [],
    };
    const result = parseMessagesRequest(req);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('messages array is required');
    }
  });

  it('rejects missing model', () => {
    const req = {
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    } as MessagesRequest;
    const result = parseMessagesRequest(req);
    expect('error' in result).toBe(true);
  });

  it('rejects missing max_tokens', () => {
    const req = {
      model: 'sonnet',
      messages: [{ role: 'user', content: 'Hi' }],
    } as MessagesRequest;
    const result = parseMessagesRequest(req);
    expect('error' in result).toBe(true);
  });
});

// ============================================================================
// Response formatting
// ============================================================================

describe('formatMessagesResponse', () => {
  it('wraps a successful response in Anthropic format', () => {
    const proxyRes: ProxyResponse = {
      text: 'Hello! How can I help?',
      model: 'sonnet',
      inputTokens: 150,
      outputTokens: 42,
    };
    const res = formatMessagesResponse(proxyRes, 'claude-sonnet-4-5-20250929');

    expect(res.type).toBe('message');
    expect(res.role).toBe('assistant');
    expect(res.model).toBe('claude-sonnet-4-5-20250929');
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toBe('Hello! How can I help?');
    expect(res.stop_reason).toBe('end_turn');
    expect(res.stop_sequence).toBeNull();
    expect(res.usage.input_tokens).toBe(150);
    expect(res.usage.output_tokens).toBe(42);
    expect(res.id).toMatch(/^msg_[a-f0-9]+$/);
  });

  it('defaults token counts to 0 when missing', () => {
    const proxyRes: ProxyResponse = { text: 'response' };
    const res = formatMessagesResponse(proxyRes, 'sonnet');

    expect(res.usage.input_tokens).toBe(0);
    expect(res.usage.output_tokens).toBe(0);
  });
});

// ============================================================================
// Error formatting
// ============================================================================

describe('formatErrorResponse', () => {
  it('returns correct structure for invalid_request_error', async () => {
    const res = formatErrorResponse('invalid_request_error', 'Bad request', 400);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('Bad request');
  });

  it('returns correct structure for authentication_error', async () => {
    const res = formatErrorResponse('authentication_error', 'Invalid key', 401);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });

  it('returns correct structure for overloaded_error', async () => {
    const res = formatErrorResponse('overloaded_error', 'Queue full', 503);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.type).toBe('overloaded_error');
  });

  it('returns correct structure for api_error', async () => {
    const res = formatErrorResponse('api_error', 'Internal error', 500);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.type).toBe('api_error');
  });
});

// ============================================================================
// SSE streaming format
// ============================================================================

describe('formatStreamingResponse', () => {
  it('returns proper SSE event sequence', async () => {
    const proxyRes: ProxyResponse = {
      text: 'Hello stream!',
      inputTokens: 50,
      outputTokens: 10,
    };
    const res = formatStreamingResponse(proxyRes, 'claude-sonnet-4-5-20250929');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');

    const body = await res.text();

    // Check event sequence
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_start');
    expect(body).toContain('event: ping');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: content_block_stop');
    expect(body).toContain('event: message_delta');
    expect(body).toContain('event: message_stop');

    // Verify order
    const startIdx = body.indexOf('event: message_start');
    const blockStartIdx = body.indexOf('event: content_block_start');
    const deltaIdx = body.indexOf('event: content_block_delta');
    const blockStopIdx = body.indexOf('event: content_block_stop');
    const msgDeltaIdx = body.indexOf('event: message_delta');
    const stopIdx = body.indexOf('event: message_stop');

    expect(startIdx).toBeLessThan(blockStartIdx);
    expect(blockStartIdx).toBeLessThan(deltaIdx);
    expect(deltaIdx).toBeLessThan(blockStopIdx);
    expect(blockStopIdx).toBeLessThan(msgDeltaIdx);
    expect(msgDeltaIdx).toBeLessThan(stopIdx);

    // Check that text content is in the delta
    expect(body).toContain('"text":"Hello stream!"');

    // Check model in message_start
    expect(body).toContain('"model":"claude-sonnet-4-5-20250929"');
  });

  it('includes correct token counts', async () => {
    const proxyRes: ProxyResponse = {
      text: 'test',
      inputTokens: 100,
      outputTokens: 25,
    };
    const res = formatStreamingResponse(proxyRes, 'sonnet');
    const body = await res.text();

    // input_tokens in message_start
    expect(body).toContain('"input_tokens":100');
    // output_tokens in message_delta
    expect(body).toContain('"output_tokens":25');
  });
});
