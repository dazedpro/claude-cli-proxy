import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { log } from '../src/log';

describe('log', () => {
  let logOutput: string[] = [];
  let errorOutput: string[] = [];

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    // Capture console output
    console.log = mock((...args: unknown[]) => { logOutput.push(String(args[0])); });
    console.error = mock((...args: unknown[]) => { errorOutput.push(String(args[0])); });
  });

  it('outputs valid JSON', () => {
    log('info', 'abc123', 'TEST');
    expect(logOutput.length).toBe(1);
    const parsed = JSON.parse(logOutput[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.reqId).toBe('abc123');
    expect(parsed.msg).toBe('TEST');
    expect(parsed.ts).toBeDefined();
  });

  it('includes extra data fields', () => {
    log('info', 'abc123', 'TEST', { model: 'opus', chars: 500 });
    const parsed = JSON.parse(logOutput[0]);
    expect(parsed.model).toBe('opus');
    expect(parsed.chars).toBe(500);
  });

  it('omits reqId when null', () => {
    log('info', null, 'STARTED');
    const parsed = JSON.parse(logOutput[0]);
    expect(parsed.reqId).toBeUndefined();
  });

  it('writes errors to stderr', () => {
    log('error', 'abc123', 'FAIL', { error: 'bad' });
    expect(errorOutput.length).toBe(1);
    expect(logOutput.length).toBe(0);
    const parsed = JSON.parse(errorOutput[0]);
    expect(parsed.level).toBe('error');
  });

  it('writes info and warn to stdout', () => {
    log('info', null, 'INFO');
    log('warn', null, 'WARN');
    expect(logOutput.length).toBe(2);
    expect(errorOutput.length).toBe(0);
  });
});
