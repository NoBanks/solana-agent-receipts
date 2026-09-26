/**
 * ledger.ts - the off-chain half of a receipt.
 *
 * One jsonl file per agent. Each line wraps the canonical receipt with the
 * transaction that attested it; only the "receipt" object is hashed, so the
 * signature can travel with it without changing what was attested. The
 * on-chain head is what makes this file tamper-evident: edit, drop, reorder or
 * insert any line and recomputing the head no longer matches the chain.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_DIR } from "./config.js";
import type { Json } from "./canonical.js";

export type LedgerRow = {
  seq: string;
  action: string;
  receipt_hash: string;
  prev_receipt_hash: string;
  signature: string;
  receipt: Json;
};

export function ledgerPath(agent: string): string {
  return join(LEDGER_DIR, `${agent.toLowerCase()}.jsonl`);
}

export function readRows(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerRow);
}

export function appendRow(agent: string, row: LedgerRow): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  appendFileSync(ledgerPath(agent), JSON.stringify(row) + "\n");
}
