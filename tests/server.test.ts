import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { _setExecutor, _resetExecutor, _resetState } from '../src/queue';
import type { ProxyResponse } from '../src/types';

// Start the server on a test port
const TEST_PORT = 9199;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  process.env.CLAUDE_PROXY_PORT = String(TEST_PORT);
  // Must set executor before importing server (which runs on import)
  _setExecutor(async () => ({
    stdout: JSON.stringify({ result: 'server test ok', input_tokens: 10, output_tokens: 5, model: 'sonnet' }),
    stderr: '',
    exitCode: 0,
    killed: false,
  }));

  // Dynamically import modules
  const { loadConfig } = await import('../src/types');
  const { enqueue, getMetrics, getActive, getQueued } = await import('../src/queue');
  const {
    parseMessagesRequest,
    formatMessagesResponse,
    formatErrorResponse,
    formatStreamingResponse,
  } = await import('../src/compat');

  const config = loadConfig();

  server = Bun.serve({
    port: TEST_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({
          ok: true,
          active: getActive(),
          queued: getQueued(),
          maxConcurrent: config.maxConcurrent,
          maxQueue: config.maxQueueDepth,
        });
      }

      if (url.pathname === '/metrics' && req.method === 'GET') {
        const metrics = getMetrics(config);
        return Response.json({ uptime: 0, ...metrics });
      }

      if (url.pathname === '/chat' && req.method === 'POST') {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json({ text: '', error: 'Invalid JSON body' }, { status: 400 });
        }
        if (!body.prompt) {
          return Response.json({ text: '', error: 'prompt is required' }, { status: 400 });
        }
        return enqueue(body, config);
      }

      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        // Auth check
        if (config.proxyApiKey) {
          const apiKey = req.headers.get('x-api-key');
          if (apiKey !== config.proxyApiKey) {
            return formatErrorResponse(
              'authentication_error',
              'Invalid API key. Set the x-api-key header to match PROXY_API_KEY.',
              401,
            );
          }
        }

        let body: any;
        try {
          body = await req.json();
        } catch {
          return formatErrorResponse('invalid_request_error', 'Invalid JSON body', 400);
        }

        const parsed = parseMessagesRequest(body);
        if ('error' in parsed) {
          return formatErrorResponse('invalid_request_error', parsed.error, 400);
        }

        const { proxyReq, stream } = parsed;
        const requestModel = body.model;

        const internalRes = await enqueue(proxyReq, config);
        const internalBody = (await internalRes.clone().json()) as ProxyResponse & { error?: string };

        if (internalRes.status !== 200) {
          const errorType = internalRes.status === 503 ? 'overloaded_error' as const : 'api_error' as const;
          return formatErrorResponse(errorType, internalBody.error || 'Internal error', internalRes.status);
        }

        if (stream) {
          return formatStreamingResponse(internalBody, requestModel);
        }

        return Response.json(formatMessagesResponse(internalBody, requestModel));
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop();
  delete process.env.CLAUDE_PROXY_PORT;
  delete process.env.PROXY_API_KEY;
  _resetExecutor();
});

beforeEach(() => {
  _resetState();
});

const base = `http://localhost:${TEST_PORT}`;

// ============================================================================
// Original endpoints (backward compatibility)
// ============================================================================

describe('GET /health', () => {
  it('returns health status', async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.active).toBe(0);
    expect(body.queued).toBe(0);
    expect(typeof body.maxConcurrent).toBe('number');
    expect(typeof body.maxQueue).toBe('number');
  });
});

describe('GET /metrics', () => {
  it('returns metrics', async () => {
    const res = await fetch(`${base}/metrics`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(typeof body.uptime).toBe('number');
    expect(body.requests).toBeDefined();
    expect(body.tokens).toBeDefined();
    expect(body.latency).toBeDefined();
  });
});

describe('POST /chat', () => {
  it('returns successful response', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.text).toBe('server test ok');
    expect(body.model).toBe('sonnet');
  });

  it('rejects missing prompt with 400', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('prompt is required');
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('Invalid JSON');
  });

  it('accepts priority parameter', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'urgent', priority: 'high' }),
    });

    expect(res.status).toBe(200);
  });
});

describe('unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${base}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for wrong method on /chat', async () => {
    const res = await fetch(`${base}/chat`);
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /v1/messages (Anthropic API-compatible endpoint)
// ============================================================================

describe('POST /v1/messages', () => {
  it('returns Anthropic-format response for valid request', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Say hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toBe('server test ok');
    expect(body.stop_reason).toBe('end_turn');
    expect(body.stop_sequence).toBeNull();
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
    expect(body.id).toMatch(/^msg_/);
  });

  it('rejects missing messages with Anthropic error format', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', max_tokens: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('messages');
  });

  it('rejects invalid JSON with Anthropic error format', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('handles multi-turn conversation', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And 3+3?' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.content[0].text).toBe('server test ok');
  });

  it('handles system prompt', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        system: 'You are a pirate.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('message');
  });

  it('returns SSE stream when stream: true', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const body = await res.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('server test ok');
  });

  it('accepts anthropic-version header without enforcing', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2024-99-99',
      },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(200);
  });

  it('works without anthropic-version header', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(200);
  });
});

// ============================================================================
// Auth (PROXY_API_KEY)
// ============================================================================

describe('POST /v1/messages auth', () => {
  it('requires no auth when PROXY_API_KEY is not set', async () => {
    // PROXY_API_KEY is not set by default in test setup
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonnet',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(200);
  });

  // Note: Testing PROXY_API_KEY enforcement requires the config to be loaded
  // with the env var set. Since the test server loads config once at startup,
  // we test the auth logic indirectly through the compat tests.
  // A full auth integration test would require a separate server instance.
});
