/**
 * server.ts - public, read-only view of the agents. No keys are loaded here.
 *
 *   GET /                      the page
 *   GET /api/status            per agent: on-chain head/count read live, ledger rows, last receipts
 *   GET /ledger/<agent>.jsonl  the raw ledger, the input verify.ts takes
 *
 * Every number on the page is read at request time: the head and count from the
 * agent's log account on chain, the rows from the ledger files the runner writes.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc, type Address } from "@solana/kit";
import { AGENTS, CLUSTER, POOL, PROGRAM_ID, PYTH_SOL_USD, RPC_URL, explorerAddress, explorerTx } from "./config.js";
import { fetchAgentLog, agentLogAddress } from "./program.js";
import { ledgerPath, readRows } from "./ledger.js";
import { receiptHash, type Json } from "./canonical.js";

const PORT = Number(process.env.PORT ?? 17370);
const ADDRESSES: Record<string, string> = JSON.parse(process.env.AGENT_ADDRESSES ?? "{}");
const rpc = createSolanaRpc(RPC_URL);
const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.html"), "utf8");

async function status() {
  const agents: unknown[] = [];
  for (const name of AGENTS) {
    const authority = ADDRESSES[name];
    const rows = readRows(ledgerPath(name));
    const log = authority ? await fetchAgentLog(rpc, authority as Address) : null;
    const rehashOk = rows.every((r) => receiptHash(r.receipt as Json) === r.receipt_hash);
    agents.push({
      name,
      authority,
      agent_log: authority ? String(await agentLogAddress(authority as Address)) : null,
      agent_log_url: authority ? explorerAddress(String(await agentLogAddress(authority as Address))) : null,
      onchain_count: log ? log.count.toString() : null,
      onchain_head: log?.head ?? null,
      ledger_rows: rows.length,
      counts_match: log ? log.count === BigInt(rows.length) : false,
      rows_rehash: rehashOk,
      trades: rows.filter((r) => r.action !== "HOLD").length,
      last_at: log ? new Date(log.lastAt * 1000).toISOString() : null,
      recent: rows.slice(-12).reverse().map((r) => {
        const rc = r.receipt as Record<string, Json>;
        const sig = rc.signal as Record<string, Json>;
        const sw = rc.swap as Record<string, Json>;
        return {
          seq: r.seq,
          action: r.action,
          reason: rc.reason,
          at: rc.timestamp,
          price: sig ? `${sig.price}e${sig.exponent}` : null,
          swap_in: sw && sw.input_amount ? `${sw.input_amount} ${String(sw.input_mint).startsWith("So111") ? "lamports" : "devUSDC units"}` : null,
          receipt_hash: r.receipt_hash,
          tx: explorerTx(r.signature),
        };
      }),
    });
  }
  return {
    cluster: CLUSTER,
    program: String(PROGRAM_ID),
    program_url: explorerAddress(String(PROGRAM_ID)),
    pool_url: explorerAddress(String(POOL)),
    pyth_url: explorerAddress(String(PYTH_SOL_USD)),
    read_at: new Date().toISOString(),
    agents,
  };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (url.pathname === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(await status(), null, 2));
    }
    const m = url.pathname.match(/^\/ledger\/(passive|aggressive|rebalance)\.jsonl$/);
    if (m) {
      const p = ledgerPath(m[1]);
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      return res.end(existsSync(p) ? readFileSync(p) : "");
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e).slice(0, 300));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`agent receipts page on http://127.0.0.1:${PORT}`));
