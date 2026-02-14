import type { ProxyConfig } from './types';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

/** The CLI command to invoke. Overridable for testing. */
export let CLI_COMMAND = 'claude';

export function _setCliCommand(cmd: string) { CLI_COMMAND = cmd; }
export function _resetCliCommand() { CLI_COMMAND = 'claude'; }

export async function executeClaudeCli(
  args: string[],
  timeoutMs: number,
  _config: ProxyConfig,
): Promise<ExecutionResult> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_TASK_LIST_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const proc = Bun.spawn([CLI_COMMAND, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode, killed };
}
