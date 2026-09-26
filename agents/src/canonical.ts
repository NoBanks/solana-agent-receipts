/**
 * canonical.ts - the receipt hashing rule.
 *
 * Byte-for-byte the same rule traide-arc-agents and traide-keeper use in Python:
 *     json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
 *     sha256(those bytes)
 * so one verifier can check receipts from either chain. To keep the two
 * languages from ever disagreeing, receipts carry no floats: every number is
 * an integer, and anything that could exceed 2^53 (lamports, prices, slots)
 * is a decimal string. assertCanonicalSafe() enforces that before hashing.
 */
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function assertCanonicalSafe(v: Json, path = "receipt"): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`${path} is ${v}: receipts carry integers only (use a string)`);
  } else if (typeof v === "string") {
    // Python's json.dumps escapes non-ASCII by default; JSON.stringify does not.
    if (/[^\x20-\x7e]/.test(v)) throw new Error(`${path} has non-ASCII or control characters`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertCanonicalSafe(x, `${path}[${i}]`));
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) assertCanonicalSafe(x, `${path}.${k}`);
  }
}

export function canonicalBytes(receipt: Json): Buffer {
  assertCanonicalSafe(receipt);
  return Buffer.from(JSON.stringify(sortKeys(receipt)), "utf8");
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 64 lower-hex characters, no 0x. Same convention as traide-keeper. */
export function receiptHash(receipt: Json): string {
  return sha256Hex(canonicalBytes(receipt));
}
