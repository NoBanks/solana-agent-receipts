/**
 * config.ts - every address here was read from a live source, never guessed.
 *
 *   PROGRAM_ID     read from idl/ (written by `anchor build`)
 *   POOL           Orca Whirlpool SOL/devUSDC, tick spacing 64. Confirmed on
 *                  devnet 2026-09-26 with fetchWhirlpool: mintA = wSOL,
 *                  mintB = devUSDC, config = Orca's devnet WhirlpoolsConfig,
 *                  vaults held ~396 SOL / ~6,120 devUSDC.
 *   PYTH_SOL_USD   Pyth's sponsored SOL/USD PriceUpdateV2 account on devnet,
 *                  owned by the Pyth receiver program. Its feed id decodes to
 *                  ef0d8b6f...b56d, the published SOL/USD feed id.
 *
 * Anything that differs per deployment comes from the environment.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { address, type Address } from "@solana/kit";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IDL = JSON.parse(readFileSync(join(REPO_ROOT, "idl", "solana_agent_receipts.json"), "utf8"));

export const PROGRAM_ID: Address = address(process.env.RECEIPTS_PROGRAM_ID ?? IDL.address);
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = process.env.CLUSTER ?? "devnet";

export const ORCA_WHIRLPOOL_PROGRAM: Address = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const POOL: Address = address(process.env.POOL ?? "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
export const WSOL_MINT: Address = address("So11111111111111111111111111111111111111112");
export const DEV_USDC_MINT: Address = address("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k");
export const PYTH_SOL_USD: Address = address(process.env.PYTH_ACCOUNT ?? "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const KEY_DIR = process.env.AGENT_KEY_DIR ?? join(homedir(), ".config", "solana-agent-receipts");
export const LEDGER_DIR = process.env.LEDGER_DIR ?? join(REPO_ROOT, "data");

export const AGENTS = ["PASSIVE", "AGGRESSIVE", "REBALANCE"] as const;
export type AgentName = (typeof AGENTS)[number];

export const CYCLE_SECONDS = Number(process.env.CYCLE_SECONDS ?? 300);
export const SLIPPAGE_BPS = 100;
/** Lamports every agent keeps back for fees and rent, never traded. */
export const SOL_RESERVE_LAMPORTS = 50_000_000n;
/** Trade sizes. Small on purpose: this is devnet evidence, not a P&L contest. */
export const MIN_SOL_IN = 5_000_000n; // 0.005 SOL
export const MAX_SOL_IN = 50_000_000n; // 0.05 SOL
export const MIN_USDC_IN = 100_000n; // 0.10 devUSDC
export const MAX_USDC_IN = 1_000_000n; // 1.00 devUSDC
/** Refuse to act on a Pyth price older than this or with a wide confidence band. */
// Measured 2026-09-27 (scripts/pyth_cadence.ts, 36 samples): Pyth's sponsored SOL/USD account on
// devnet updates about every 634 s; median age 463 s, max 635 s. 120 s made the agents refuse ~90%
// of cycles. 900 s covers one devnet update gap with margin; every receipt records the real age.
export const PYTH_MAX_AGE_SECONDS = Number(process.env.PYTH_MAX_AGE_SECONDS ?? 900);
export const PYTH_MAX_CONF_BPS = 100;

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}
export function explorerAddress(a: string): string {
  return `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;
}
