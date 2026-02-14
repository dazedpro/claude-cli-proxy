import { loadConfig, type ProxyRequest } from './types';
import { enqueue, getMetrics, getActive, getQueued } from './queue';
import { log } from './log';

const config = loadConfig();
const startedAt = Date.now();

Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    // GET /health
    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        ok: true,
        active: getActive(),
        queued: getQueued(),
        maxConcurrent: config.maxConcurrent,
        maxQueue: config.maxQueueDepth,
      });
    }

    // GET /metrics
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const metrics = getMetrics(config);
      return Response.json({
        uptime: Math.round((Date.now() - startedAt) / 1000),
        ...metrics,
      });
    }

    // POST /chat
    if (url.pathname === '/chat' && req.method === 'POST') {
      let body: ProxyRequest;
      try {
        body = (await req.json()) as ProxyRequest;
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

log('info', null, 'STARTED', {
  port: config.port,
  maxConcurrent: config.maxConcurrent,
  maxQueue: config.maxQueueDepth,
  queueTimeoutMs: config.queueTimeoutMs,
  defaultMaxTurns: config.defaultMaxTurns,
  defaultTimeoutMs: config.defaultTimeoutMs,
});
