# claude-cli-proxy

**Use your Claude Pro/Max subscription instead of paying for API calls.**

An HTTP proxy that lets any service call Claude through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) via a simple REST API. Your existing Claude subscription covers the usage — no API keys, no per-token billing, no Anthropic API account needed.

Replace `fetch('https://api.anthropic.com/v1/messages', ...)` with `fetch('http://localhost:9100/v1/messages', ...)` and stop paying per token. Existing code using the Anthropic SDK can switch by changing **one env var** — zero code changes.

## Why?

Anthropic's API charges per token. But if you have a Claude Pro ($20/mo) or Max ($100-200/mo) subscription, the Claude Code CLI gives you included usage at no extra cost. This proxy turns that CLI into an HTTP service that any app, container, or script can call — with priority queuing, concurrency management, and structured logging built in.

**Before:** Each API call costs money. 100K input tokens + 20K output tokens on Opus = ~$18.
**After:** Same call, $0. It runs through your subscription.

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

- **Anthropic API Compatible** — drop-in `/v1/messages` endpoint; switch with one env var
- **Priority Queue** — HIGH / NORMAL / LOW priorities with FIFO ordering within each level
- **Concurrency Control** — configurable max parallel CLI processes (default: 5)
- **Queue Depth Limiting** — bounded queue with configurable max depth (default: 20)
- **Queue Timeouts** — requests waiting too long are rejected with 408
- **Per-Request Timeouts** — processes killed after configurable timeout (default: 180s)
- **Optional API Key Auth** — set `PROXY_API_KEY` to secure shared/exposed proxies
- **Streaming Support** — `stream: true` returns proper SSE event format
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

## Using with the Anthropic SDK (Drop-in Replacement)

The `/v1/messages` endpoint accepts the exact same request/response format as `api.anthropic.com`. Existing code using the Anthropic SDK works with **zero code changes** — just set env vars.

### Zero-code-change method (recommended)

```bash
# The Anthropic SDK reads these automatically
export ANTHROPIC_BASE_URL=http://localhost:9100
export ANTHROPIC_API_KEY=dummy  # required by SDK but not checked unless PROXY_API_KEY is set

# In Docker Compose:
environment:
  ANTHROPIC_BASE_URL: http://host.docker.internal:9100
  ANTHROPIC_API_KEY: dummy
```

### One-line-change method

```python
# Python
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:9100", api_key="dummy")
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

```typescript
// TypeScript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:9100", apiKey: "dummy" });
const response = await client.messages.create({
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Secured mode (shared/exposed proxy)

```bash
# On the proxy host:
PROXY_API_KEY=my-secret-key pm2 restart claude-cli-proxy

# Clients use the key as their "API key":
export ANTHROPIC_BASE_URL=http://proxy-host:9100
export ANTHROPIC_API_KEY=my-secret-key
```

### Limitations

- **No image/vision content blocks** — text only (image blocks return a clear error)
- **No tool_use/tool_choice** — the CLI handles tools internally
- **Sampling params accepted but ignored** — `temperature`, `top_p`, `top_k`, `max_tokens` are accepted for compatibility but the CLI controls these
- **Fake streaming** — `stream: true` returns proper SSE event format, but the full response is delivered at once (not token-by-token)
- **Model mapping** — full model IDs (e.g. `claude-sonnet-4-5-20250929`) are mapped to CLI short names (`sonnet`). Short names also work directly.

## API

### POST /v1/messages (Anthropic-compatible)

Standard Anthropic Messages API format. See [Anthropic API docs](https://docs.anthropic.com/en/api/messages).

**Request:**

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "What is the capital of France?"}
  ]
}
```

**Response (200):**

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "The capital of France is Paris."}],
  "model": "claude-sonnet-4-5-20250929",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 25, "output_tokens": 12}
}
```

**Error (4xx/5xx):**

```json
{
  "type": "error",
  "error": {"type": "invalid_request_error", "message": "messages array is required and must not be empty"}
}
```

**Streaming (`stream: true`):**

Returns `text/event-stream` with standard Anthropic SSE events: `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`.

### POST /chat (Simple endpoint)

Send a prompt to Claude and get a response. Simpler than the Messages API but not SDK-compatible.

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

Note: The `/v1/messages` endpoint uses `normal` priority by default. Use the `/chat` endpoint if you need priority control.

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `9100` | HTTP server port |
| `MAX_CONCURRENT` | `5` | Max parallel Claude CLI processes |
| `MAX_QUEUE_DEPTH` | `20` | Max requests waiting in queue |
| `QUEUE_TIMEOUT_MS` | `60000` | Max time a request can wait in queue (ms) |
| `PROXY_API_KEY` | *(unset)* | If set, requires `x-api-key` header to match on `/v1/messages` |

Default per-request settings (overridable per request via `/chat`):

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

## Client Examples

### Using the Anthropic SDK (recommended)

```python
import anthropic
import os

os.environ["ANTHROPIC_BASE_URL"] = "http://localhost:9100"
client = anthropic.Anthropic(api_key="dummy")

response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku about coding"}]
)
print(response.content[0].text)
```

### Using the simple /chat endpoint

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
├── server.ts     # HTTP routing (Bun.serve) — /chat, /v1/messages, /health, /metrics
├── compat.ts     # Anthropic API format translation (request/response/streaming/errors)
├── queue.ts      # Priority queue, concurrency manager, request execution
├── executor.ts   # CLI process spawning (thin wrapper around Bun.spawn)
├── log.ts        # Structured JSON logger
└── types.ts      # Shared interfaces and config loader
```

## License

MIT
