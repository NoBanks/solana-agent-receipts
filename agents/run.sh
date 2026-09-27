#!/bin/bash
# run.sh <runner|server> - PM2 entry point.
# RPC_URL is read at launch from TRAIDE's .env (keyed Helius devnet endpoint). It is never
# written to this repo or echoed; the public devnet RPC rate-limits (HTTP 429) a 3-agent loop.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${RPC_ENV_FILE:-$HOME/Documents/TRAIDE/.env}"
RPC_URL="$(grep '^SOLANA_DEVNET_RPC_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ')"
export RPC_URL CLUSTER=devnet
KD="${AGENT_KEY_DIR:-$HOME/.config/solana-agent-receipts}"
export AGENT_ADDRESSES="$(node -e '
const fs=require("fs");const kd=process.argv[1];
import("@solana/kit").then(async k=>{const o={};for(const n of ["PASSIVE","AGGRESSIVE","REBALANCE"]){
const s=await k.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(kd+"/"+n.toLowerCase()+".json","utf8"))));o[n]=s.address}
process.stdout.write(JSON.stringify(o))})' "$KD")"
case "${1:-runner}" in
  runner) exec npx tsx src/runner.ts loop ;;
  server) exec npx tsx src/server.ts ;;
  *) echo "usage: run.sh runner|server" >&2; exit 2 ;;
esac
