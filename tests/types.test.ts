import { describe, it, expect, afterEach } from 'bun:test';
import { loadConfig, PRIORITY, PRIORITY_MAP } from '../src/types';

describe('loadConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    // Restore env
    delete process.env.CLAUDE_PROXY_PORT;
    delete process.env.MAX_CONCURRENT;
    delete process.env.MAX_QUEUE_DEPTH;
    delete process.env.QUEUE_TIMEOUT_MS;
    delete process.env.DEFAULT_MAX_TURNS;
    delete process.env.DEFAULT_TIMEOUT_MS;
    delete process.env.PERMISSION_MODE;
  });

  it('returns defaults when no env vars set', () => {
    delete process.env.CLAUDE_PROXY_PORT;
    delete process.env.MAX_CONCURRENT;
    delete process.env.MAX_QUEUE_DEPTH;
    delete process.env.QUEUE_TIMEOUT_MS;
    delete process.env.DEFAULT_MAX_TURNS;
    delete process.env.DEFAULT_TIMEOUT_MS;
    delete process.env.PERMISSION_MODE;

    const config = loadConfig();
    expect(config.port).toBe(9100);
    expect(config.maxConcurrent).toBe(5);
    expect(config.maxQueueDepth).toBe(20);
    expect(config.queueTimeoutMs).toBe(60_000);
    expect(config.defaultMaxTurns).toBe(100);
    expect(config.defaultTimeoutMs).toBe(600_000);
    expect(config.permissionMode).toBe('default');
  });

  it('reads from environment variables', () => {
    process.env.CLAUDE_PROXY_PORT = '8080';
    process.env.MAX_CONCURRENT = '10';
    process.env.MAX_QUEUE_DEPTH = '50';
    process.env.QUEUE_TIMEOUT_MS = '120000';

    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.maxConcurrent).toBe(10);
    expect(config.maxQueueDepth).toBe(50);
    expect(config.queueTimeoutMs).toBe(120_000);
  });
});

describe('PRIORITY constants', () => {
  it('HIGH < NORMAL < LOW (lower number = higher priority)', () => {
    expect(PRIORITY.HIGH).toBeLessThan(PRIORITY.NORMAL);
    expect(PRIORITY.NORMAL).toBeLessThan(PRIORITY.LOW);
  });

  it('PRIORITY_MAP maps labels to numeric values', () => {
    expect(PRIORITY_MAP.high).toBe(PRIORITY.HIGH);
    expect(PRIORITY_MAP.normal).toBe(PRIORITY.NORMAL);
    expect(PRIORITY_MAP.low).toBe(PRIORITY.LOW);
  });
});
