/**
 * verify.ts - re-derive every claim from public data. No keys needed.
 *
 *   npx tsx src/verify.ts <agent authority address> <ledger.jsonl path or https URL> [--tx all|N]
 *
 * Checks, in order:
 *   1. every ledger row's receipt re-hashes to its receipt_hash
 *   2. rows are numbered 0..n-1 and each prev_receipt_hash links to the row before
 *   3. replaying the head over (registration policy, policy updates, rows) gives
 *      exactly the head stored on chain, and the chain's count equals the rows.
 *      This is the one that catches a dropped, edited, reordered or inserted row.
 *   4. for each checked row, the transaction on chain succeeded, emitted a
 *      ReceiptAttested event with the same hash / seq / action, and a BUY or SELL
 *      carries the agent's own swap on its venue in the same transaction
 */
import { readFileSync } from "node:fs";
import { address, createSolanaRpc, getBase58Encoder, signature as toSig, type Address } from "@solana/kit";
import { RPC_URL, explorerTx } from "./config.js";
import { receiptHash, type Json } from "./canonical.js";
import {
  ACTION, ZERO32, agentLogAddress, decodeReceiptAttested, fetchAgentLog,
  nextPolicyHead, nextReceiptHead, type ActionName,
} from "./program.js";
import { IDL } from "./config.js";
import type { LedgerRow } from "./ledger.js";

const rpc = createSolanaRpc(RPC_URL);

/** Public RPCs rate-limit (HTTP 429). Back off and retry instead of failing a judge's run. */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= 7 || !/429|Too Many|fetch failed|ECONNRESET/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function loadRows(src: string): Promise<LedgerRow[]> {
  const text = src.startsWith("http") ? await (await fetch(src)).text() : readFileSync(src, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

type PolicyEvent = { version: number; policyHash: string; atSeq: bigint };

function eventDisc(name: string): Buffer {
  return Buffer.from(IDL.events.find((e: { name: string }) => e.name === name).discriminator);
}

/** Registration + every policy change, read from the agent log's own transaction history. */
async function policyHistory(logAddr: Address, receiptSigs: Set<string>): Promise<PolicyEvent[]> {
  const out: PolicyEvent[] = [];
  let before: string | undefined;
  const regDisc = eventDisc("AgentRegistered");
  const polDisc = eventDisc("PolicyUpdated");
  for (;;) {
    const sigs = await withRetry(() => rpc.getSignaturesForAddress(logAddr, { limit: 1000, ...(before ? { before: toSig(before) } : {}) }).send());
    if (sigs.length === 0) break;
    for (const s of sigs) {
      // Receipt transactions carry only ReceiptAttested; registration and policy changes are the
      // only other writes to the log, so fetch just those (a handful, not the whole history).
      if (s.err || receiptSigs.has(String(s.signature))) continue;
      const tx = await withRetry(() => rpc.getTransaction(s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
      for (const inner of tx?.meta?.innerInstructions ?? []) {
        for (const ix of inner.instructions) {
          const data = Buffer.from(base58ToBytes(ix.data as string));
          if (data.length < 16) continue;
          const d = data.subarray(8, 16);
          if (d.equals(regDisc)) {
            // agent_log 32 | authority 32 | venue 32 | name 32 | policy_hash 32 ...
            out.push({ version: 1, policyHash: data.subarray(16 + 128, 16 + 160).toString("hex"), atSeq: 0n });
          } else if (d.equals(polDisc)) {
            // agent_log 32 | policy_hash 32 | policy_version u32 | at_seq u64 ...
            out.push({
              version: data.readUInt32LE(16 + 64),
              policyHash: data.subarray(16 + 32, 16 + 64).toString("hex"),
              atSeq: data.readBigUInt64LE(16 + 68),
            });
          }
        }
      }
    }
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  return out.sort((a, b) => a.version - b.version);
}

const b58 = getBase58Encoder();
function base58ToBytes(s: string): Uint8Array {
  return Uint8Array.from(b58.encode(s));
}

async function checkTx(row: LedgerRow, logAddr: string, venue: string, authority: string): Promise<string | null> {
  const tx = await withRetry(() => rpc.getTransaction(toSig(row.signature), { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
  if (!tx) return "transaction not found";
  if (tx.meta?.err) return `transaction failed: ${JSON.stringify(tx.meta.err)}`;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ].map(String);
  let event: ReturnType<typeof decodeReceiptAttested> = null;
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const ev = decodeReceiptAttested(Buffer.from(base58ToBytes(ix.data as string)));
      if (ev && ev.agentLog === logAddr) event = ev;
    }
  }
  if (!event) return "no ReceiptAttested event for this agent";
  if (event.receiptHash !== row.receipt_hash) return `event hash ${event.receiptHash} != ledger ${row.receipt_hash}`;
  if (event.seq.toString() !== row.seq) return `event seq ${event.seq} != ledger ${row.seq}`;
  if (event.action !== ACTION[row.action as ActionName]) return `event action ${event.action} != ledger ${row.action}`;
  const venueCalls = tx.transaction.message.instructions.filter((ix) => keys[ix.programIdIndex] === venue);
  const signerCount = tx.transaction.message.header.numRequiredSignatures;
  const agentSigned = keys.slice(0, signerCount).includes(authority);
  if (row.action === "HOLD" && venueCalls.length) return "HOLD transaction contains a venue call";
  if (row.action !== "HOLD" && (!venueCalls.length || !agentSigned)) return "trade receipt without the agent's own venue call";
  return null;
}

async function main() {
  const [authorityArg, src, flag, flagVal] = process.argv.slice(2);
  if (!authorityArg || !src) {
    console.error("usage: verify.ts <agent authority address> <ledger.jsonl | https URL> [--tx all|N]");
    process.exit(2);
  }
  const authority = address(authorityArg);
  // A live agent can land a receipt between the ledger download and the chain read. Read the
  // chain first, then the ledger; if the ledger is still behind, re-read both (a few tries) so a
  // snapshot race is never reported as tampering. Any real gap persists and is reported below.
  let log = await withRetry(() => fetchAgentLog(rpc, authority));
  if (!log) throw new Error(`no AgentLog for ${authority}`);
  let rows = await loadRows(src);
  for (let i = 0; i < 3 && BigInt(rows.length) !== log.count; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    log = (await withRetry(() => fetchAgentLog(rpc, authority)))!;
    rows = await loadRows(src);
  }
  // Still mismatched after the retries = a real gap or extra rows; reported as a problem below.
  const logAddr = String(await agentLogAddress(authority));
  const problems: string[] = [];

  // 1 + 2: the ledger on its own
  let prev = ZERO32;
  rows.forEach((r, i) => {
    if (receiptHash(r.receipt as Json) !== r.receipt_hash) problems.push(`row ${i}: receipt does not hash to receipt_hash`);
    if (r.seq !== String(i)) problems.push(`row ${i}: seq is ${r.seq}`);
    if ((r.receipt as { seq?: string }).seq !== r.seq) problems.push(`row ${i}: receipt.seq disagrees with row seq`);
    if (r.prev_receipt_hash !== prev) problems.push(`row ${i}: prev_receipt_hash does not link to row ${i - 1}`);
    prev = r.receipt_hash;
  });

  // 3: replay the head
  const policies = await policyHistory(logAddr as Address, new Set(rows.map((r) => r.signature)));
  if (!policies.length || policies[0].version !== 1) problems.push("registration event not found on chain");
  let head = ZERO32;
  let p = 0;
  const applyPolicies = (upToSeq: bigint) => {
    while (p < policies.length && policies[p].atSeq <= upToSeq) {
      head = nextPolicyHead(head, policies[p].policyHash, policies[p].version);
      p++;
    }
  };
  rows.forEach((r, i) => {
    applyPolicies(BigInt(i));
    head = nextReceiptHead(head, r.receipt_hash, BigInt(i), r.action as ActionName);
  });
  applyPolicies(BigInt(rows.length));
  const headOk = head === log.head;
  const countOk = log.count === BigInt(rows.length);
  if (!headOk) problems.push(`replayed head ${head} != on-chain head ${log.head}`);
  if (!countOk) problems.push(`on-chain count ${log.count} != ledger rows ${rows.length}`);

  // 4: transactions
  const want = flag === "--tx" ? flagVal : "20";
  const all = rows.map((_, i) => i);
  const idx = want === "all" ? all : Number(want) > 0 ? all.slice(-Number(want)) : [];
  let txChecked = 0;
  for (const i of idx) {
    const err = await checkTx(rows[i], logAddr, log.venue, String(authority));
    txChecked++;
    if (err) problems.push(`row ${i} (${explorerTx(rows[i].signature)}): ${err}`);
  }

  const trades = rows.filter((r) => r.action !== "HOLD").length;
  const report = {
    agent: log.name,
    agent_log: logAddr,
    rows: rows.length,
    trades,
    holds: rows.length - trades,
    policy_versions: policies.length,
    onchain_head: log.head,
    replayed_head: head,
    head_matches: headOk,
    count_matches: countOk,
    transactions_checked: txChecked,
    problems,
    ok: problems.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

await main();
