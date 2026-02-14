// ============================================================================
// Anthropic Messages API compatibility layer
//
// Translates between the standard Anthropic /v1/messages format and the
// internal ProxyRequest/ProxyResponse format used by the queue/executor.
// ============================================================================

import type { ProxyRequest, ProxyResponse } from './types';

// ============================================================================
// Types — Anthropic API message format
// ============================================================================

interface TextContentBlock {
  type: 'text';
  text: string;
}

interface ImageContentBlock {
  type: 'image';
  [key: string]: unknown;
}

type ContentBlock = TextContentBlock | ImageContentBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface MessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
  // tool_use / tool_choice intentionally not supported
}

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: TextContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ErrorResponse {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'overloaded_error' | 'api_error';
    message: string;
  };
}

// ============================================================================
// Model mapping — full Anthropic model IDs → short CLI names
// ============================================================================

const MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6': 'opus',
  'claude-opus-4-20250916': 'opus',
  'claude-sonnet-4-5-20250929': 'sonnet',
  'claude-sonnet-4-5-20241022': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
  // Proxy's own model ID — let claude CLI use its default model
  'claude-cli-proxy': '',
};

export function mapModelId(model: string): string {
  // Direct match in map (use `in` to handle empty-string values)
  if (model in MODEL_MAP) return MODEL_MAP[model];
  // Pattern-based: claude-opus-* → opus, claude-sonnet-* → sonnet, claude-haiku-* → haiku
  if (model.startsWith('claude-opus')) return 'opus';
  if (model.startsWith('claude-sonnet')) return 'sonnet';
  if (model.startsWith('claude-haiku')) return 'haiku';
  // Short names pass through (opus, sonnet, haiku)
  return model;
}

// ============================================================================
// Request conversion — Anthropic MessagesRequest → internal ProxyRequest
// ============================================================================

export function parseMessagesRequest(req: MessagesRequest): { proxyReq: ProxyRequest; stream: boolean } | { error: string } {
  if (!req.messages || !Array.isArray(req.messages) || req.messages.length === 0) {
    return { error: 'messages array is required and must not be empty' };
  }

  if (!req.model) {
    return { error: 'model is required' };
  }

  if (!req.max_tokens || typeof req.max_tokens !== 'number') {
    return { error: 'max_tokens is required and must be a number' };
  }

  // Build prompt from messages
  let prompt: string;
  const messages = req.messages;

  // Check for unsupported content types
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'image') {
          return { error: 'Image content blocks are not supported. This proxy only handles text.' };
        }
      }
    }
  }

  if (messages.length === 1 && messages[0].role === 'user') {
    // Single user message — use content directly
    prompt = extractText(messages[0].content);
  } else {
    // Multi-turn — format as conversation
    const parts: string[] = [];
    for (const msg of messages) {
      const label = msg.role === 'user' ? 'Human' : 'Assistant';
      parts.push(`${label}: ${extractText(msg.content)}`);
    }
    prompt = parts.join('\n\n');
  }

  const proxyReq: ProxyRequest = {
    prompt,
    model: mapModelId(req.model),
  };

  if (req.system) {
    proxyReq.systemPrompt = req.system;
  }

  return { proxyReq, stream: req.stream ?? false };
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ============================================================================
// Response conversion — internal ProxyResponse → Anthropic MessagesResponse
// ============================================================================

export function formatMessagesResponse(
  proxyRes: ProxyResponse,
  requestModel: string,
): MessagesResponse {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: proxyRes.text }],
    model: requestModel,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: proxyRes.inputTokens ?? 0,
      output_tokens: proxyRes.outputTokens ?? 0,
    },
  };
}

// ============================================================================
// Error conversion — wrap errors in Anthropic error format
// ============================================================================

export function formatErrorResponse(
  type: ErrorResponse['error']['type'],
  message: string,
  status: number,
): Response {
  const body: ErrorResponse = {
    type: 'error',
    error: { type, message },
  };
  return Response.json(body, { status });
}

// ============================================================================
// Streaming — fake SSE wrapping a complete response
// ============================================================================

export function formatStreamingResponse(
  proxyRes: ProxyResponse,
  requestModel: string,
): Response {
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const inputTokens = proxyRes.inputTokens ?? 0;
  const outputTokens = proxyRes.outputTokens ?? 0;

  const events = [
    // message_start
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })}\n`,

    // content_block_start
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n`,

    // ping
    `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n`,

    // content_block_delta — full text in one delta
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: proxyRes.text },
    })}\n`,

    // content_block_stop
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0,
    })}\n`,

    // message_delta
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })}\n`,

    // message_stop
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n`,
  ];

  const body = events.join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
