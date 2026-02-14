# claude-cli-proxy

An HTTP proxy server that routes LLM requests through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), providing priority queuing, concurrency management, structured logging, and metrics.

Built for environments where multiple services (Docker containers, microservices, background workers) need to share a single Claude CLI installation on the host machine.

## Why?

The Claude CLI authenticates via tokens stored in `~/.claude/` on the host. Containerized services can't easily access these credentials. This proxy runs on the host and exposes a simple HTTP API that any service can call — no credential sharing, no CLI installation per container.

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────┐
│  Docker Service │────>│  claude-cli-proxy │────>│ Claude CLI│
│  (port 3001)    │     │  (port 9100)      │     │ (~/.claude)│
└─────────────────┘     └──────────────────┘     └───────────┘
┌─────────────────┐            │
│  Docker Service │────────────┘
│  (port 3002)    │
└─────────────────┘
```

Docker containers reach the proxy via `host.docker.internal:9100`.

## Features

- **Priority Queue** — HIGH / NORMAL / LOW priorities with FIFO ordering within each level
- **Concurrency Control** — configurable max parallel CLI processes (default: 5)
- **Queue Depth Limiting** — bounded queue with configurable max depth (default: 20)
- **Queue Timeouts** — requests waiting too long are rejected with 408
- **Per-Request Timeouts** — processes killed after configurable timeout (default: 180s)
- **Structured JSON Logging** — one JSON line per event for easy parsing
- **Metrics Endpoint** — request counts, token usage, latency percentiles
- **Health Check** — quick status for load balancers and monitoring
- **Zero External Dependencies** — pure Bun, no npm packages needed at runtime
- **pm2 Ready** — included ecosystem config for process management

## Requirements

- [Bun](https://bun.sh) >= 1.1
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` in PATH)
- [pm2](https://pm2.keymetrics.io/) (optional, for process management)

## Quick Start

```bash
# Clone
git clone https://github.com/dazedpro/claude-cli-proxy.git
cd claude-cli-proxy

# Install dev dependencies
bun install

# Run directly
bun run start

# Or with pm2 (recommended for production)
pm2 start ecosystem.config.cjs
```

The server starts on port **9100** by default.

## API

### POST /chat

Send a prompt to Claude and get a response.

**Request:**

```json
{
  "prompt": "Explain quantum computing in one paragraph",
  "model": "sonnet",
  "systemPrompt": "You are a physics teacher",
  "maxTurns": 2,
  "timeoutMs": 180000,
  "priority": "normal"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | `string` | *required* | The prompt to send to Claude |
| `model` | `string` | CLI default | `opus`, `sonnet`, or `haiku` |
| `systemPrompt` | `string` | — | System prompt for the conversation |
| `maxTurns` | `number` | `2` | Max agentic turns (tool use cycles) |
| `timeoutMs` | `number` | `180000` | Per-request timeout in milliseconds |
| `priority` | `string` | `normal` | Queue priority: `high`, `normal`, or `low` |

**Response (200):**

```json
{
  "text": "Quantum computing harnesses quantum mechanical phenomena...",
  "model": "claude-sonnet-4-5-20250929",
  "inputTokens": 150,
  "outputTokens": 89
}
```

**Error responses:**

| Status | Meaning |
|--------|---------|
| 400 | Missing `prompt` or invalid JSON |
| 408 | Request waited too long in queue |
| 422 | Reached max turns limit |
| 502 | Claude CLI process failed |
| 503 | Queue full |
| 504 | Request timed out during execution |

### GET /health

Quick health check for monitoring.

```json
{
  "ok": true,
  "active": 3,
  "queued": 1,
  "maxConcurrent": 5,
  "maxQueue": 20
}
```

### GET /metrics

Detailed operational metrics.

```json
{
  "uptime": 3600,
  "requests": {
    "total": 150,
    "completed": 140,
    "failed": 8,
    "timedOut": 2,
    "queueRejected": 0
  },
  "active": 3,
  "queued": 1,
  "tokens": {
    "input": 500000,
    "output": 120000
  },
  "latency": {
    "avg": 45000,
    "p95": 90000,
    "min": 8000,
    "max": 180000
  }
}
```

## Priority Queue

Requests are processed by priority (HIGH before NORMAL before LOW), with FIFO ordering within the same priority level.

| Priority | Value | Use Case |
|----------|-------|----------|
| `high` | 1 | Interactive / user-facing (scoring, thumbnails) |
| `normal` | 2 | Standard generation (scripts, summaries) |
| `low` | 3 | Background / batch work (research, extraction) |

When a slot opens up, the highest-priority queued request is processed next. If the queue is full, new requests are rejected with 503.

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `9100` | HTTP server port |
| `MAX_CONCURRENT` | `5` | Max parallel Claude CLI processes |
| `MAX_QUEUE_DEPTH` | `20` | Max requests waiting in queue |
| `QUEUE_TIMEOUT_MS` | `60000` | Max time a request can wait in queue (ms) |

Default per-request settings (overridable per request):

| Setting | Default | Description |
|---------|---------|-------------|
| Max turns | `2` | Agentic turn limit per request |
| Timeout | `180000` | Per-request execution timeout (ms) |

## Process Management (pm2)

The included `ecosystem.config.cjs` configures pm2:

```bash
# Start
pm2 start ecosystem.config.cjs

# Management
pm2 stop claude-cli-proxy
pm2 restart claude-cli-proxy
pm2 logs claude-cli-proxy
pm2 status

# Survive reboots
pm2 save
pm2 startup
```

## Logging

All log output is structured JSON, one line per event:

```jsonl
{"ts":"2026-02-14T17:00:00Z","level":"info","msg":"STARTED","port":9100,"maxConcurrent":5}
{"ts":"2026-02-14T17:00:01Z","level":"info","reqId":"abc123","msg":"EXEC","model":"opus","priority":"high","promptLen":5000,"active":3,"queued":1}
{"ts":"2026-02-14T17:01:06Z","level":"info","reqId":"abc123","msg":"RES","elapsedMs":65000,"chars":12000,"inputTokens":8000,"outputTokens":4000}
```

| Message | Level | Meaning |
|---------|-------|---------|
| `STARTED` | info | Server started |
| `EXEC` | info | Request started processing |
| `RES` | info | Request completed successfully |
| `QUEUED` | info | Request added to queue |
| `QUEUE_FULL` | warn | Request rejected (queue at capacity) |
| `QUEUE_TIMEOUT` | warn | Queued request expired |
| `TIMEOUT` | warn | Running request timed out |
| `MAX_TURNS` | warn | Hit agentic turn limit |
| `PROC_FAIL` | error | Claude CLI exited with non-zero code |
| `ERR` | error | Unexpected error during execution |

## Client Example

```typescript
const response = await fetch('http://localhost:9100/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Write a haiku about coding',
    model: 'haiku',
    priority: 'low',
  }),
});

const { text, inputTokens, outputTokens } = await response.json();
console.log(text);
```

From Docker containers, replace `localhost` with `host.docker.internal`:

```typescript
const PROXY_URL = 'http://host.docker.internal:9100/chat';
```

## Development

```bash
# Install dependencies
bun install

# Run in watch mode
bun run dev

# Run tests
bun test

# Run tests with coverage
bun run test:coverage

# Typecheck
bun run typecheck
```

## Architecture

```
src/
├── server.ts     # HTTP routing (Bun.serve)
├── queue.ts      # Priority queue, concurrency manager, request execution
├── executor.ts   # CLI process spawning (thin wrapper around Bun.spawn)
├── log.ts        # Structured JSON logger
└── types.ts      # Shared interfaces and config loader
```

## License

MIT
