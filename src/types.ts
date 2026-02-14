// ============================================================================
// Priority levels
// ============================================================================

export const PRIORITY = {
  HIGH: 1,    // Interactive/user-facing (hook scoring, thumbnail gen)
  NORMAL: 2,  // Standard generation (script gen, post copy, cue gen)
  LOW: 3,     // Background/batch (research, trend analysis, extraction)
} as const;

export type PriorityLabel = 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<PriorityLabel, number> = {
  high: PRIORITY.HIGH,
  normal: PRIORITY.NORMAL,
  low: PRIORITY.LOW,
};

// ============================================================================
// Request / Response
// ============================================================================

export interface ProxyRequest {
  prompt: string;
  model?: string;           // 'opus' | 'sonnet' | 'haiku'
  systemPrompt?: string;
  maxTurns?: number;        // default 2
  timeoutMs?: number;       // default 180_000
  priority?: PriorityLabel; // default 'normal'
}

export interface ProxyResponse {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

// ============================================================================
// Queue internals
// ============================================================================

export interface QueueItem {
  reqId: string;
  request: ProxyRequest;
  priority: number;
  enqueuedAt: number;
  resolve: (response: Response) => void;
}

// ============================================================================
// Metrics
// ============================================================================

export interface Metrics {
  uptime: number;
  requests: {
    total: number;
    completed: number;
    failed: number;
    timedOut: number;
    queueRejected: number;
  };
  active: number;
  queued: number;
  tokens: {
    input: number;
    output: number;
  };
  latency: {
    avg: number;
    p95: number;
    min: number;
    max: number;
  };
}

// ============================================================================
// Config
// ============================================================================

export interface ProxyConfig {
  port: number;
  maxConcurrent: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  defaultMaxTurns: number;
  defaultTimeoutMs: number;
  proxyApiKey: string | undefined;
}

export function loadConfig(): ProxyConfig {
  return {
    port: Number(process.env.CLAUDE_PROXY_PORT ?? 9100),
    maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 5),
    maxQueueDepth: Number(process.env.MAX_QUEUE_DEPTH ?? 20),
    queueTimeoutMs: Number(process.env.QUEUE_TIMEOUT_MS ?? 60_000),
    defaultMaxTurns: 2,
    defaultTimeoutMs: 180_000,
    proxyApiKey: process.env.PROXY_API_KEY || undefined,
  };
}
