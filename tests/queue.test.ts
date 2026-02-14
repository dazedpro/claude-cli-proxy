import { describe, it, expect, beforeEach } from 'bun:test';
import { enqueue, getMetrics, getActive, getQueued, _setExecutor, _resetExecutor, _resetState } from '../src/queue';
import type { ProxyConfig } from '../src/types';
import type { ExecutionResult } from '../src/executor';

const TEST_CONFIG: ProxyConfig = {
  port: 9100,
  maxConcurrent: 2,
  maxQueueDepth: 5,
  queueTimeoutMs: 5_000,
  defaultMaxTurns: 2,
  defaultTimeoutMs: 30_000,
};

function mockExecutor(result: Partial<ExecutionResult> & { delay?: number } = {}): typeof import('../src/executor').executeClaudeCli {
  return async () => {
    if (result.delay) await new Promise((r) => setTimeout(r, result.delay));
    return {
      stdout: result.stdout ?? JSON.stringify({ result: 'test response', input_tokens: 100, output_tokens: 50, model: 'opus' }),
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
      killed: result.killed ?? false,
    };
  };
}

beforeEach(() => {
  _resetState();
  _resetExecutor();
});

// ============================================================================
// Basic request handling
// ============================================================================

describe('enqueue', () => {
  it('processes a request and returns a successful response', async () => {
    _setExecutor(mockExecutor());

    const response = await enqueue({ prompt: 'Hello world' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe('test response');
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(body.model).toBe('opus');
  });

  it('handles CLI process failure (non-zero exit code)', async () => {
    _setExecutor(mockExecutor({ exitCode: 1, stderr: 'Something went wrong' }));

    const response = await enqueue({ prompt: 'fail me' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toContain('Something went wrong');
  });

  it('handles CLI failure with empty stderr', async () => {
    _setExecutor(mockExecutor({ exitCode: 1, stderr: '' }));

    const response = await enqueue({ prompt: 'fail' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toContain('exit code 1');
  });

  it('handles CLI timeout (killed process)', async () => {
    _setExecutor(mockExecutor({ killed: true }));

    const response = await enqueue({ prompt: 'slow request', timeoutMs: 1000 }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body.error).toContain('timed out');
  });

  it('handles max-turns exhaustion', async () => {
    _setExecutor(mockExecutor({
      stdout: JSON.stringify({ result: 'Reached max turns limit' }),
    }));

    const response = await enqueue({ prompt: 'complex request' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toContain('max turns');
  });

  it('handles executor throwing an exception', async () => {
    _setExecutor(async () => { throw new Error('spawn failed'); });

    const response = await enqueue({ prompt: 'crash' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain('spawn failed');
  });

  it('handles executor throwing a non-Error', async () => {
    _setExecutor(async () => { throw 'string error'; });

    const response = await enqueue({ prompt: 'crash' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain('string error');
  });
});

// ============================================================================
// JSON output parsing — all branches
// ============================================================================

describe('JSON output parsing', () => {
  it('handles JSON string output', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify('just a string') }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe('just a string');
  });

  it('handles JSON with .result as string', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ result: 'hello' }) }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.text).toBe('hello');
  });

  it('handles JSON with .result as object (stringifies)', async () => {
    const obj = { foo: 'bar', num: 42 };
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ result: obj }) }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.text).toBe(JSON.stringify(obj));
  });

  it('handles JSON with .text field', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ text: 'from text field' }) }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.text).toBe('from text field');
  });

  it('handles JSON with no recognized field (fallback to raw)', async () => {
    const raw = JSON.stringify({ something: 'else' });
    _setExecutor(mockExecutor({ stdout: raw }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.text).toBe(raw);
  });

  it('handles plain text stdout (non-JSON)', async () => {
    _setExecutor(mockExecutor({ stdout: 'Just plain text, no JSON' }));

    const response = await enqueue({ prompt: 'plain' }, TEST_CONFIG);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe('Just plain text, no JSON');
  });

  it('reads inputTokens from snake_case field', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ result: 'ok', input_tokens: 42, output_tokens: 10 }) }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.inputTokens).toBe(42);
    expect(body.outputTokens).toBe(10);
  });

  it('reads inputTokens from camelCase field', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ result: 'ok', inputTokens: 55, outputTokens: 20 }) }));

    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    const body = await response.json();

    expect(body.inputTokens).toBe(55);
    expect(body.outputTokens).toBe(20);
  });
});

// ============================================================================
// CLI arg forwarding
// ============================================================================

describe('CLI arg forwarding', () => {
  it('passes model and systemPrompt through to CLI args', async () => {
    let capturedArgs: string[] = [];
    _setExecutor(async (args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    await enqueue({ prompt: 'test', model: 'haiku', systemPrompt: 'Be brief' }, TEST_CONFIG);

    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('haiku');
    expect(capturedArgs).toContain('--system-prompt');
    expect(capturedArgs).toContain('Be brief');
  });

  it('uses default maxTurns when not specified', async () => {
    let capturedArgs: string[] = [];
    _setExecutor(async (args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    await enqueue({ prompt: 'test' }, TEST_CONFIG);

    const turnsIndex = capturedArgs.indexOf('--max-turns');
    expect(turnsIndex).toBeGreaterThan(-1);
    expect(capturedArgs[turnsIndex + 1]).toBe('2');
  });

  it('uses custom maxTurns when specified', async () => {
    let capturedArgs: string[] = [];
    _setExecutor(async (args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    await enqueue({ prompt: 'test', maxTurns: 5 }, TEST_CONFIG);

    const turnsIndex = capturedArgs.indexOf('--max-turns');
    expect(capturedArgs[turnsIndex + 1]).toBe('5');
  });

  it('omits model and systemPrompt args when not provided', async () => {
    let capturedArgs: string[] = [];
    _setExecutor(async (args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    await enqueue({ prompt: 'test' }, TEST_CONFIG);

    expect(capturedArgs).not.toContain('--model');
    expect(capturedArgs).not.toContain('--system-prompt');
  });
});

// ============================================================================
// Priority queue behavior
// ============================================================================

describe('priority queue', () => {
  it('rejects when queue is full (503)', async () => {
    const slowConfig: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 1, maxQueueDepth: 1 };

    let resolveFirst!: () => void;

    let callCount = 0;
    _setExecutor(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    const p1 = enqueue({ prompt: 'first' }, slowConfig);
    await new Promise((r) => setTimeout(r, 10));

    const p2 = enqueue({ prompt: 'second' }, slowConfig);
    await new Promise((r) => setTimeout(r, 10));

    // Third should be rejected — queue full
    const r3 = await enqueue({ prompt: 'third' }, slowConfig);
    expect(r3.status).toBe(503);
    const body = await r3.json();
    expect(body.error).toContain('Queue full');

    resolveFirst();
    await Promise.all([p1, p2]);
  });

  it('processes high priority before normal', async () => {
    const order: string[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 1, maxQueueDepth: 10 };

    let resolveFirst!: () => void;
    let callCount = 0;

    _setExecutor(async (args) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      const promptIdx = args.indexOf('-p');
      const prompt = args[promptIdx + 1];
      order.push(prompt);
      return { stdout: JSON.stringify({ result: prompt }), stderr: '', exitCode: 0, killed: false };
    });

    const p1 = enqueue({ prompt: 'blocking', priority: 'normal' }, config);
    await new Promise((r) => setTimeout(r, 10));

    const p2 = enqueue({ prompt: 'normal-req', priority: 'normal' }, config);
    const p3 = enqueue({ prompt: 'high-req', priority: 'high' }, config);

    await new Promise((r) => setTimeout(r, 10));
    resolveFirst();

    await Promise.all([p1, p2, p3]);

    expect(order[0]).toBe('blocking');
    expect(order[1]).toBe('high-req');
    expect(order[2]).toBe('normal-req');
  });

  it('processes low priority after normal', async () => {
    const order: string[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 1, maxQueueDepth: 10 };

    let resolveFirst!: () => void;
    let callCount = 0;

    _setExecutor(async (args) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      const promptIdx = args.indexOf('-p');
      const prompt = args[promptIdx + 1];
      order.push(prompt);
      return { stdout: JSON.stringify({ result: prompt }), stderr: '', exitCode: 0, killed: false };
    });

    const p1 = enqueue({ prompt: 'blocking' }, config);
    await new Promise((r) => setTimeout(r, 10));

    const p2 = enqueue({ prompt: 'low-req', priority: 'low' }, config);
    const p3 = enqueue({ prompt: 'normal-req', priority: 'normal' }, config);

    await new Promise((r) => setTimeout(r, 10));
    resolveFirst();

    await Promise.all([p1, p2, p3]);

    expect(order[1]).toBe('normal-req');
    expect(order[2]).toBe('low-req');
  });

  it('defaults to normal priority when not specified', async () => {
    _setExecutor(mockExecutor());
    const response = await enqueue({ prompt: 'test' }, TEST_CONFIG);
    expect(response.status).toBe(200);
  });

  it('handles unknown priority gracefully (falls back to normal)', async () => {
    _setExecutor(mockExecutor());
    // Force an invalid priority via type assertion
    const response = await enqueue({ prompt: 'test', priority: 'urgent' as any }, TEST_CONFIG);
    expect(response.status).toBe(200);
  });

  it('expires queued items past queueTimeoutMs', async () => {
    const config: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 1, maxQueueDepth: 10, queueTimeoutMs: 50 };

    let resolveFirst!: () => void;
    let callCount = 0;

    _setExecutor(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    // Fill the active slot
    const p1 = enqueue({ prompt: 'blocking' }, config);
    await new Promise((r) => setTimeout(r, 10));

    // Queue a request
    const p2 = enqueue({ prompt: 'will-expire' }, config);

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 100));

    // Release the blocker — tryDequeue should drain the expired item
    resolveFirst();
    await p1;

    const r2 = await p2;
    expect(r2.status).toBe(408);
    const body = await r2.json();
    expect(body.error).toContain('Queued for too long');
  });
});

// ============================================================================
// Metrics
// ============================================================================

describe('metrics', () => {
  it('tracks completed requests and tokens', async () => {
    _setExecutor(mockExecutor());

    await enqueue({ prompt: 'test1' }, TEST_CONFIG);
    await enqueue({ prompt: 'test2' }, TEST_CONFIG);

    const m = getMetrics(TEST_CONFIG);
    expect(m.requests.total).toBe(2);
    expect(m.requests.completed).toBe(2);
    expect(m.requests.failed).toBe(0);
    expect(m.tokens.input).toBe(200);
    expect(m.tokens.output).toBe(100);
    expect(m.active).toBe(0);
    expect(m.queued).toBe(0);
  });

  it('tracks failed requests', async () => {
    _setExecutor(mockExecutor({ exitCode: 1, stderr: 'fail' }));

    await enqueue({ prompt: 'fail' }, TEST_CONFIG);

    const m = getMetrics(TEST_CONFIG);
    expect(m.requests.total).toBe(1);
    expect(m.requests.failed).toBe(1);
    expect(m.requests.completed).toBe(0);
  });

  it('tracks timed out requests', async () => {
    _setExecutor(mockExecutor({ killed: true }));

    await enqueue({ prompt: 'timeout' }, TEST_CONFIG);

    const m = getMetrics(TEST_CONFIG);
    expect(m.requests.timedOut).toBe(1);
  });

  it('tracks queue-rejected requests', async () => {
    const config: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 1, maxQueueDepth: 0 };

    let resolveFirst!: () => void;
    _setExecutor(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    const p1 = enqueue({ prompt: 'fill' }, config);
    await new Promise((r) => setTimeout(r, 10));

    await enqueue({ prompt: 'rejected' }, config);

    const m = getMetrics(config);
    expect(m.requests.queueRejected).toBe(1);

    resolveFirst();
    await p1;
  });

  it('computes latency stats', async () => {
    _setExecutor(mockExecutor());

    await enqueue({ prompt: 'test' }, TEST_CONFIG);

    const m = getMetrics(TEST_CONFIG);
    expect(m.latency.min).toBeGreaterThanOrEqual(0);
    expect(m.latency.max).toBeGreaterThanOrEqual(m.latency.min);
    expect(m.latency.avg).toBeGreaterThanOrEqual(0);
    expect(m.latency.p95).toBeGreaterThanOrEqual(0);
  });

  it('returns zero latency when no requests completed', () => {
    const m = getMetrics(TEST_CONFIG);
    expect(m.latency).toEqual({ avg: 0, p95: 0, min: 0, max: 0 });
  });

  it('does not count tokens when response has none', async () => {
    _setExecutor(mockExecutor({ stdout: JSON.stringify({ result: 'no tokens here' }) }));

    await enqueue({ prompt: 'test' }, TEST_CONFIG);

    const m = getMetrics(TEST_CONFIG);
    expect(m.tokens.input).toBe(0);
    expect(m.tokens.output).toBe(0);
  });
});

// ============================================================================
// getActive / getQueued
// ============================================================================

describe('getActive / getQueued', () => {
  it('returns 0 when idle', () => {
    expect(getActive()).toBe(0);
    expect(getQueued()).toBe(0);
  });

  it('reflects active count during execution', async () => {
    const config: ProxyConfig = { ...TEST_CONFIG, maxConcurrent: 2 };
    const resolvers: Array<() => void> = [];

    _setExecutor(async () => {
      await new Promise<void>((r) => { resolvers.push(r); });
      return { stdout: JSON.stringify({ result: 'ok' }), stderr: '', exitCode: 0, killed: false };
    });

    const p1 = enqueue({ prompt: 'a' }, config);
    const p2 = enqueue({ prompt: 'b' }, config);
    await new Promise((r) => setTimeout(r, 50));

    expect(getActive()).toBe(2);
    expect(getQueued()).toBe(0);

    // Resolve each executor
    for (const r of resolvers) r();
    await Promise.allSettled([p1, p2]);
  });
});
