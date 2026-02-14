module.exports = {
  apps: [{
    name: 'claude-cli-proxy',
    script: 'src/server.ts',
    interpreter: 'bun',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    env: {
      CLAUDE_PROXY_PORT: 9100,
      MAX_CONCURRENT: 5,
      MAX_QUEUE_DEPTH: 20,
      QUEUE_TIMEOUT_MS: 60000,
    },
  }],
};
