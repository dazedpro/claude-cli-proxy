import { describe, it, expect, afterEach } from 'bun:test';
import { executeClaudeCli, _setCliCommand, _resetCliCommand } from '../src/executor';
import type { ProxyConfig } from '../src/types';

const TEST_CONFIG: ProxyConfig = {
  port: 9100,
  maxConcurrent: 5,
  maxQueueDepth: 20,
  queueTimeoutMs: 60_000,
  defaultMaxTurns: 2,
  defaultTimeoutMs: 180_000,
};

afterEach(() => {
  _resetCliCommand();
});

describe('executeClaudeCli', () => {
  it('is an exported function', () => {
    expect(typeof executeClaudeCli).toBe('function');
  });

  it('executes a command and returns stdout', async () => {
    _setCliCommand('echo');
    const result = await executeClaudeCli(['hello world'], 5_000, TEST_CONFIG);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.killed).toBe(false);
  });

  it('captures stderr from failing commands', async () => {
    _setCliCommand('sh');
    const result = await executeClaudeCli(['-c', 'echo oops >&2 && exit 1'], 5_000, TEST_CONFIG);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe('oops');
    expect(result.killed).toBe(false);
  });

  it('kills process on timeout', async () => {
    _setCliCommand('sleep');
    const result = await executeClaudeCli(['30'], 200, TEST_CONFIG);

    expect(result.killed).toBe(true);
  });
});
