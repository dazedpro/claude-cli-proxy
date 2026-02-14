import { loadConfig, type ProxyRequest, type ProxyResponse } from './types';
import { enqueue, getMetrics, getActive, getQueued } from './queue';
import {
  parseMessagesRequest,
  formatMessagesResponse,
  formatErrorResponse,
  formatStreamingResponse,
  type MessagesRequest,
} from './compat';
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

    // POST /chat (original custom endpoint)
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

    // POST /v1/messages (Anthropic API-compatible endpoint)
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      // Auth check: if PROXY_API_KEY is set, require matching x-api-key header
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

      // Parse request body
      let body: MessagesRequest;
      try {
        body = (await req.json()) as MessagesRequest;
      } catch {
        return formatErrorResponse('invalid_request_error', 'Invalid JSON body', 400);
      }

      // Convert to internal format
      const parsed = parseMessagesRequest(body);
      if ('error' in parsed) {
        return formatErrorResponse('invalid_request_error', parsed.error, 400);
      }

      const { proxyReq, stream } = parsed;
      const requestModel = body.model;

      // Enqueue through existing queue system
      const internalRes = await enqueue(proxyReq, config);

      // Read internal response
      const internalBody = (await internalRes.clone().json()) as ProxyResponse & { error?: string };

      // If internal request failed, map to Anthropic error format
      if (internalRes.status !== 200) {
        const errorType = internalRes.status === 503 ? 'overloaded_error' as const : 'api_error' as const;
        return formatErrorResponse(errorType, internalBody.error || 'Internal error', internalRes.status);
      }

      // Format successful response
      if (stream) {
        return formatStreamingResponse(internalBody, requestModel);
      }

      return Response.json(formatMessagesResponse(internalBody, requestModel));
    }

    log('warn', null, 'NOT_FOUND', { method: req.method, path: url.pathname });
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
