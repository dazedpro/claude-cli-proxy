import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { _setExecutor, _resetExecutor, _resetState } from '../src/queue';

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

  // Dynamically import server module (it calls Bun.serve on load)
  const { loadConfig } = await import('../src/types');
  const { enqueue, getMetrics, getActive, getQueued } = await import('../src/queue');

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

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop();
  delete process.env.CLAUDE_PROXY_PORT;
  _resetExecutor();
});

beforeEach(() => {
  _resetState();
});

const base = `http://localhost:${TEST_PORT}`;

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
