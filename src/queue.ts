import { type QueueItem, type ProxyConfig, type ProxyRequest, type ProxyResponse, PRIORITY_MAP } from './types';
import { executeClaudeCli, type ExecutionResult } from './executor';
import { log } from './log';

// Allow tests to override the executor
export let _executor: typeof executeClaudeCli = executeClaudeCli;
export function _setExecutor(fn: typeof executeClaudeCli) { _executor = fn; }
export function _resetExecutor() { _executor = executeClaudeCli; }

// ============================================================================
// State
// ============================================================================

let activeCount = 0;
const queue: QueueItem[] = [];
const latencies: number[] = [];

// Cumulative metrics
let totalRequests = 0;
let completedRequests = 0;
let failedRequests = 0;
let timedOutRequests = 0;
let queueRejectedRequests = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;

// ============================================================================
// Metrics accessors
// ============================================================================

export function getMetrics(config: ProxyConfig) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95Index = Math.floor(sorted.length * 0.95);
  return {
    requests: {
      total: totalRequests,
      completed: completedRequests,
      failed: failedRequests,
      timedOut: timedOutRequests,
      queueRejected: queueRejectedRequests,
    },
    active: activeCount,
    queued: queue.length,
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    latency: sorted.length > 0
      ? {
          avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
          p95: sorted[p95Index] ?? sorted[sorted.length - 1],
          min: sorted[0],
          max: sorted[sorted.length - 1],
        }
      : { avg: 0, p95: 0, min: 0, max: 0 },
  };
}

export function getActive() { return activeCount; }
export function getQueued() { return queue.length; }

/** Reset all state — for testing only */
export function _resetState() {
  activeCount = 0;
  queue.length = 0;
  latencies.length = 0;
  totalRequests = 0;
  completedRequests = 0;
  failedRequests = 0;
  timedOutRequests = 0;
  queueRejectedRequests = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
}

// ============================================================================
// Queue management
// ============================================================================

function insertSorted(item: QueueItem) {
  // Insert maintaining priority order (lower number = higher priority), FIFO within same
  let i = queue.length;
  while (i > 0 && queue[i - 1].priority > item.priority) {
    i--;
  }
  queue.splice(i, 0, item);
}

function drainExpired(config: ProxyConfig) {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (now - item.enqueuedAt > config.queueTimeoutMs) {
      queue.splice(i, 1);
      timedOutRequests++;
      log('warn', item.reqId, 'QUEUE_TIMEOUT', {
        waitedMs: now - item.enqueuedAt,
        priority: item.request.priority ?? 'normal',
      });
      item.resolve(Response.json(
        { text: '', error: `Queued for too long (>${config.queueTimeoutMs}ms)` },
        { status: 408 },
      ));
    }
  }
}

function tryDequeue(config: ProxyConfig) {
  drainExpired(config);
  while (activeCount < config.maxConcurrent && queue.length > 0) {
    const item = queue.shift()!;
    // Check if this item already expired (race condition guard)
    if (Date.now() - item.enqueuedAt > config.queueTimeoutMs) {
      timedOutRequests++;
      item.resolve(Response.json(
        { text: '', error: `Queued for too long (>${config.queueTimeoutMs}ms)` },
        { status: 408 },
      ));
      continue;
    }
    executeRequest(item, config);
  }
}

// ============================================================================
// Request execution — spawns `claude` CLI process
// ============================================================================

async function executeRequest(item: QueueItem, config: ProxyConfig) {
  activeCount++;
  const start = performance.now();
  const { reqId, request } = item;
  const { prompt, model, systemPrompt } = request;
  const maxTurns = request.maxTurns ?? config.defaultMaxTurns;
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;

  log('info', reqId, 'EXEC', {
    model: model || 'default',
    priority: request.priority ?? 'normal',
    turns: maxTurns,
    timeoutS: Math.round(timeoutMs / 1000),
    promptLen: prompt.length,
    active: activeCount,
    queued: queue.length,
  });

  try {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      '--permission-mode', config.permissionMode,
    ];
    if (model) args.push('--model', model);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    const { stdout, stderr, exitCode, killed } = await _executor(args, timeoutMs, config);
    const elapsedMs = performance.now() - start;

    if (killed) {
      timedOutRequests++;
      log('warn', reqId, 'TIMEOUT', { elapsedMs: Math.round(elapsedMs), timeoutS: Math.round(timeoutMs / 1000) });
      item.resolve(Response.json(
        { text: '', error: `Request timed out after ${Math.round(timeoutMs / 1000)}s` },
        { status: 504 },
      ));
      return;
    }

    if (exitCode !== 0) {
      failedRequests++;
      log('error', reqId, 'PROC_FAIL', { elapsedMs: Math.round(elapsedMs), exitCode, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) });
      item.resolve(Response.json(
        { text: '', error: stderr.slice(0, 500) || `exit code ${exitCode}` },
        { status: 502 },
      ));
      return;
    }

    // Parse JSON output
    let responseText = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let responseModel: string | undefined;

    try {
      let jsonOut = JSON.parse(stdout.trim());

      // CLI --output-format json can return an array of conversation events.
      // Find the last "result" event or assistant message to extract the response.
      if (Array.isArray(jsonOut)) {
        const resultEntry = jsonOut.findLast((e: any) => e.type === 'result')
          ?? jsonOut.findLast((e: any) => e.type === 'assistant');
        jsonOut = resultEntry ?? jsonOut;
      }

      // Detect error_max_turns subtype (CLI returns this with no result/text field)
      if (jsonOut.subtype === 'error_max_turns') {
        failedRequests++;
        log('warn', reqId, 'MAX_TURNS', { elapsedMs: Math.round(elapsedMs), maxTurns });
        item.resolve(Response.json(
          { text: '', error: `Reached max turns (${maxTurns}). Increase maxTurns for complex requests.` },
          { status: 422 },
        ));
        return;
      }

      if (typeof jsonOut === 'string') {
        responseText = jsonOut;
      } else if (jsonOut.result !== undefined) {
        responseText = typeof jsonOut.result === 'string' ? jsonOut.result : JSON.stringify(jsonOut.result);
      } else if (jsonOut.text !== undefined) {
        responseText = jsonOut.text;
      } else {
        responseText = stdout.trim();
      }
      inputTokens = jsonOut.input_tokens ?? jsonOut.inputTokens;
      outputTokens = jsonOut.output_tokens ?? jsonOut.outputTokens;
      responseModel = jsonOut.model;
    } catch {
      responseText = stdout.trim();
    }

    // Check for max-turns exhaustion
    if (responseText.includes('Reached max turns')) {
      failedRequests++;
      log('warn', reqId, 'MAX_TURNS', { elapsedMs: Math.round(elapsedMs), maxTurns });
      item.resolve(Response.json(
        { text: '', error: `Reached max turns (${maxTurns}). Increase maxTurns for complex requests.` },
        { status: 422 },
      ));
      return;
    }

    // Success
    completedRequests++;
    latencies.push(Math.round(elapsedMs));
    // Keep latencies array bounded (last 1000)
    if (latencies.length > 1000) latencies.splice(0, latencies.length - 1000);
    if (inputTokens) totalInputTokens += inputTokens;
    if (outputTokens) totalOutputTokens += outputTokens;

    log('info', reqId, 'RES', {
      elapsedMs: Math.round(elapsedMs),
      chars: responseText.length,
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      model: responseModel ?? null,
    });

    item.resolve(Response.json({
      text: responseText,
      model: responseModel,
      inputTokens,
      outputTokens,
    } satisfies ProxyResponse));

  } catch (err) {
    failedRequests++;
    const msg = err instanceof Error ? err.message : String(err);
    log('error', reqId, 'ERR', { elapsedMs: Math.round(performance.now() - start), error: msg });
    item.resolve(Response.json({ text: '', error: msg }, { status: 500 }));
  } finally {
    activeCount--;
    tryDequeue(config);
  }
}

// ============================================================================
// Public entry point — called by server.ts for each /chat request
// ============================================================================

export function enqueue(request: ProxyRequest, config: ProxyConfig): Promise<Response> {
  totalRequests++;
  const reqId = crypto.randomUUID().slice(0, 8);
  const priorityLabel = request.priority ?? 'normal';
  const priority = PRIORITY_MAP[priorityLabel] ?? PRIORITY_MAP.normal;

  // If a slot is available, execute immediately
  if (activeCount < config.maxConcurrent) {
    return new Promise<Response>((resolve) => {
      const item: QueueItem = {
        reqId,
        request,
        priority,
        enqueuedAt: Date.now(),
        resolve,
      };
      executeRequest(item, config);
    });
  }

  // Queue is full
  if (queue.length >= config.maxQueueDepth) {
    queueRejectedRequests++;
    log('warn', reqId, 'QUEUE_FULL', {
      priority: priorityLabel,
      queued: queue.length,
      maxQueue: config.maxQueueDepth,
    });
    return Promise.resolve(
      Response.json(
        { text: '', error: `Queue full (${queue.length}/${config.maxQueueDepth})` },
        { status: 503 },
      ),
    );
  }

  // Enqueue
  log('info', reqId, 'QUEUED', {
    priority: priorityLabel,
    position: queue.length + 1,
    active: activeCount,
  });

  return new Promise<Response>((resolve) => {
    insertSorted({
      reqId,
      request,
      priority,
      enqueuedAt: Date.now(),
      resolve,
    });
  });
}
