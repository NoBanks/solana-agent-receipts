#!/bin/bash
# capture_terminal.sh - runs the demo commands for real and saves each one, with its full output and the
# UTC time it ran, to data/terminal/<name>.txt. server.ts shows them at /terminal/<name>. Nothing is typed
# by hand or edited afterwards; re-run this to refresh them.
#
#   verify   fresh clone of the public repo, verify all three agents against the public ledgers
#   tamper   download one ledger, drop a row / rewrite-and-rehash a row, verify each copy
set -uo pipefail
cd "$(dirname "$0")/.."
SITE="${SITE:-https://solana-receipts.nohumannearby.com}"
OUT="../data/terminal"; mkdir -p "$OUT"
WORK="$(mktemp -d)"
ADDR() { curl -s "$SITE/api/status" | python3 -c "import json,sys;d=json.load(sys.stdin);print([a['authority'] for a in d['agents'] if a['name']=='$1'][0])"; }

run() {  # run <outfile> <shown command> <real command>
  { echo "\$ $2"; bash -c "$3" 2>/dev/null; echo; } >> "$1"
}

# ---------- verify from a fresh clone ----------
F="$OUT/verify.txt"; : > "$F"
git clone -q https://github.com/NoBanks/solana-agent-receipts "$WORK/clone" && (cd "$WORK/clone/agents" && npm install --silent >/dev/null 2>&1)
echo "\$ git clone https://github.com/NoBanks/solana-agent-receipts && cd solana-agent-receipts/agents && npm install" >> "$F"; echo >> "$F"
for A in PASSIVE AGGRESSIVE REBALANCE; do
  a=$(echo "$A" | tr A-Z a-z); addr=$(ADDR "$A")
  run "$F" "npx tsx src/verify.ts $addr $SITE/ledger/$a.jsonl --tx 20" \
    "cd '$WORK/clone/agents' && env -u RPC_URL npx tsx src/verify.ts $addr $SITE/ledger/$a.jsonl --tx 20"
done
echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ) on Solana devnet, public RPC, no keys" >> "$F"

# ---------- tamper ----------
F="$OUT/tamper.txt"; : > "$F"
A=REBALANCE; a=rebalance; addr=$(ADDR "$A")
curl -s "$SITE/ledger/$a.jsonl" -o "$WORK/$a.jsonl"
echo "\$ curl -s $SITE/ledger/$a.jsonl -o $a.jsonl" >> "$F"; echo >> "$F"
echo "# 1) delete receipt #1" >> "$F"
sed '2d' "$WORK/$a.jsonl" > "$WORK/dropped.jsonl"
echo "\$ sed '2d' $a.jsonl > dropped.jsonl" >> "$F"
run "$F" "npx tsx src/verify.ts $addr dropped.jsonl --tx 0" \
  "cd '$WORK/clone/agents' && env -u RPC_URL npx tsx src/verify.ts $addr '$WORK/dropped.jsonl' --tx 0"
echo "# 2) rewrite receipt #1's reason, re-hash it and re-link the next row so the file looks clean" >> "$F"
python3 - "$WORK/$a.jsonl" "$WORK/rewritten.jsonl" <<'EOF'
import json, sys, hashlib
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows[1]["receipt"]["reason"] = "rewritten after the fact"
rows[1]["receipt_hash"] = hashlib.sha256(json.dumps(rows[1]["receipt"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
if len(rows) > 2: rows[2]["prev_receipt_hash"] = rows[1]["receipt_hash"]
open(sys.argv[2], "w").write("".join(json.dumps(r) + "\n" for r in rows))
EOF
echo "\$ python3 rewrite_and_rehash.py $a.jsonl rewritten.jsonl" >> "$F"
run "$F" "npx tsx src/verify.ts $addr rewritten.jsonl --tx 20" \
  "cd '$WORK/clone/agents' && env -u RPC_URL npx tsx src/verify.ts $addr '$WORK/rewritten.jsonl' --tx 20"
echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ) on Solana devnet, public RPC, no keys" >> "$F"

rm -rf "$WORK"
echo "saved: $OUT/verify.txt $OUT/tamper.txt"
