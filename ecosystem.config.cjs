// PM2 entries for Agent Receipts on Solana (devnet). Crash-loop guards are mandatory: do not remove.
// One tunnel per app: solana-receipts.nohumannearby.com -> 127.0.0.1:17370.
// Bring up from this file; never pm2-save without Ryan's say-so.
module.exports = {
  apps: [
    {
      name: "solana-receipts-runner",
      script: "./agents/run.sh",
      args: "runner",
      interpreter: "/bin/bash",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      restart_delay: 5000,
    },
    {
      name: "solana-receipts-page",
      script: "./agents/run.sh",
      args: "server",
      interpreter: "/bin/bash",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      restart_delay: 5000,
      max_memory_restart: "300M",
    },
    {
      name: "solana-receipts-tunnel",
      script: "/opt/homebrew/bin/cloudflared",
      args: "tunnel --config /Users/nobanksnearby/.cloudflared/solana-agent-receipts.yml run",
      interpreter: "none",
      autorestart: true,
      max_restarts: 5,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      restart_delay: 5000,
      max_memory_restart: "150M",
    },
  ],
};
