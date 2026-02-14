// Structured JSON logger — one JSON line per event

type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, reqId: string | null, msg: string, data?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ...(reqId && { reqId }),
    msg,
    ...data,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
