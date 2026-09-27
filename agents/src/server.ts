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
import { AGENTS, CLUSTER, LEDGER_DIR, POOL, PROGRAM_ID, PYTH_SOL_USD, RPC_URL, explorerAddress, explorerTx } from "./config.js";
import { fetchAgentLog, agentLogAddress } from "./program.js";
import { ledgerPath, readRows } from "./ledger.js";
import { receiptHash, type Json } from "./canonical.js";

const PORT = Number(process.env.PORT ?? 17370);
const ADDRESSES: Record<string, string> = JSON.parse(process.env.AGENT_ADDRESSES ?? "{}");
const rpc = createSolanaRpc(RPC_URL);
const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.html"), "utf8");
const TERMINAL_DIR = join(LEDGER_DIR, "terminal");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function viewPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#0d0f14;--panel:#151922;--line:#252b38;--text:#e7eaf0;--muted:#8b93a7;--ok:#14f195;--bad:#ff5c5c;--accent:#14f195}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px}h1{font-size:24px;margin:0 0 12px}a{color:var(--accent)}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;overflow-x:auto;font:13px/1.5 ui-monospace,Menlo,monospace}
pre.term{background:#07090d;color:#d6f5e3;font-size:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}p{overflow-wrap:anywhere}
</style></head><body><main><h1>${esc(title)}</h1>${body}<p><a href="/">back to the live page</a></p></main></body></html>`;
}

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
    // /receipt/<agent>/<seq>: one receipt, pretty-printed, with its hash re-computed right here.
    const rm = url.pathname.match(/^\/receipt\/(passive|aggressive|rebalance)\/(\d+)$/);
    if (rm) {
      const row = readRows(ledgerPath(rm[1])).find((r) => r.seq === rm[2]);
      if (!row) return res.writeHead(404).end("no such receipt");
      const again = receiptHash(row.receipt as Json);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(viewPage(`${rm[1].toUpperCase()} receipt #${row.seq}`,
        `<p>receipt_hash <b>${esc(row.receipt_hash)}</b><br>re-hashed now: <b class="${again === row.receipt_hash ? "ok" : "bad"}">${esc(again)}</b></p>` +
        `<p><a href="${explorerTx(row.signature)}">transaction on the explorer</a></p><pre>${esc(JSON.stringify(row.receipt, null, 2))}</pre>`));
    }
    // /terminal/<name>: real command output saved by scripts/capture_terminal.sh, shown with the time it ran.
    const tm = url.pathname.match(/^\/terminal\/([a-z0-9_-]+)$/);
    if (tm) {
      const p = join(TERMINAL_DIR, `${tm[1]}.txt`);
      if (!existsSync(p)) return res.writeHead(404).end("no such capture");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(viewPage(tm[1], `<pre class="term">${esc(readFileSync(p, "utf8"))}</pre>`));
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
