/**
 * pyth.ts - read Pyth's SOL/USD PriceUpdateV2 account straight from chain.
 *
 * No Hermes call and no API key: Pyth keeps this account updated on devnet.
 * The account's own bytes are hashed into every receipt, so a verifier can
 * fetch the same account at the recorded slot and see exactly what the agent saw.
 *
 * Layout (pyth-solana-receiver-sdk PriceUpdateV2, Borsh):
 *   8   discriminator
 *   32  write_authority
 *   1+  verification_level  (0 = Partial{num_signatures: u8}, 1 = Full)
 *   32  feed_id
 *   8   price i64 | 8 conf u64 | 4 exponent i32
 *   8   publish_time i64 | 8 prev_publish_time i64
 *   8   ema_price i64 | 8 ema_conf u64
 *   8   posted_slot u64
 */
import type { Address, Rpc, GetAccountInfoApi } from "@solana/kit";
import { PYTH_SOL_USD_FEED_ID } from "./config.js";
import { sha256Hex } from "./canonical.js";

export type PythPrice = {
  account: string;
  feedId: string;
  verification: "full" | "partial";
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
  contextSlot: bigint;
  accountSha256: string;
};

export async function readPyth(rpc: Rpc<GetAccountInfoApi>, account: Address): Promise<PythPrice> {
  const res = await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send();
  if (!res.value) throw new Error(`Pyth account ${account} not found`);
  const b = Buffer.from(res.value.data[0], "base64");
  const tag = b[40];
  const o = tag === 0 ? 42 : 41;
  const feedId = b.subarray(o, o + 32).toString("hex");
  if (feedId !== PYTH_SOL_USD_FEED_ID) throw new Error(`unexpected feed id ${feedId}`);
  return {
    account: String(account),
    feedId,
    verification: tag === 0 ? "partial" : "full",
    price: b.readBigInt64LE(o + 32),
    conf: b.readBigUInt64LE(o + 40),
    exponent: b.readInt32LE(o + 48),
    publishTime: Number(b.readBigInt64LE(o + 52)),
    emaPrice: b.readBigInt64LE(o + 68),
    emaConf: b.readBigUInt64LE(o + 76),
    postedSlot: b.readBigUInt64LE(o + 84),
    contextSlot: res.context.slot,
    accountSha256: sha256Hex(b),
  };
}

/** Deviation of spot from EMA in basis points, integer math only. */
export function deviationBps(p: PythPrice): number {
  return Number(((p.price - p.emaPrice) * 10_000n) / p.emaPrice);
}

export function confBps(p: PythPrice): number {
  return Number((p.conf * 10_000n) / (p.price < 0n ? -p.price : p.price));
}
