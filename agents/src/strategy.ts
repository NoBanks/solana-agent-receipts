/**
 * strategy.ts - the three agents, ported from traide-arc-agents.
 *
 * Shared, non-negotiable guard: no fresh, tight Pyth price means HOLD, with the
 * reason written into the receipt. There is no fallback price source.
 *
 *   PASSIVE     contrarian, smallest size. Buys SOL when spot sits well under
 *               its EMA, sells when well over.
 *   AGGRESSIVE  trend follower. Buys when spot runs above EMA, sells when it
 *               falls under, and scales size with the move.
 *   REBALANCE   keeps its own inventory near a 50/50 value split at the pool's
 *               execution price and trades the difference back.
 *
 * The signal is the real SOL/USD market (Pyth). Execution is the devnet Orca
 * pool, whose price is set by devnet liquidity, not the market. Receipts record
 * both so nobody mistakes one for the other.
 */
import {
  MAX_SOL_IN, MAX_USDC_IN, MIN_SOL_IN, MIN_USDC_IN,
  PYTH_MAX_AGE_SECONDS, PYTH_MAX_CONF_BPS, SOL_RESERVE_LAMPORTS, type AgentName,
} from "./config.js";
import { confBps, deviationBps, type PythPrice } from "./pyth.js";
import type { ActionName } from "./program.js";

export type Decision = {
  action: ActionName;
  reason: string;
  /** SELL spends SOL (lamports); BUY spends devUSDC (6-decimal units). */
  inputAmount: bigint;
};

export type Inventory = { lamports: bigint; usdcUnits: bigint };
/** Pool execution price as devUSDC units per 1 SOL (1e9 lamports). */
export type PoolPrice = { usdcUnitsPerSol: bigint };

const PASSIVE_BAND_BPS = 30;
const TREND_BAND_BPS = 15;
const REBALANCE_BAND_PCT = 8n;

function clamp(v: bigint, lo: bigint, hi: bigint): bigint {
  return v < lo ? lo : v > hi ? hi : v;
}

function hold(reason: string): Decision {
  return { action: "HOLD", reason, inputAmount: 0n };
}

export function policyDocument(): Record<string, number | string> {
  // Hashed at registration and committed on chain as policy_hash. Change any
  // number here and the agent must call update_policy, which the head records.
  return {
    aggressive_band_bps: TREND_BAND_BPS,
    max_sol_in_lamports: MAX_SOL_IN.toString(),
    max_usdc_in_units: MAX_USDC_IN.toString(),
    min_sol_in_lamports: MIN_SOL_IN.toString(),
    min_usdc_in_units: MIN_USDC_IN.toString(),
    passive_band_bps: PASSIVE_BAND_BPS,
    pyth_max_age_s: PYTH_MAX_AGE_SECONDS,
    pyth_max_conf_bps: PYTH_MAX_CONF_BPS,
    rebalance_band_pct: REBALANCE_BAND_PCT.toString(),
    sol_reserve_lamports: SOL_RESERVE_LAMPORTS.toString(),
    strategy_file: "agents/src/strategy.ts",
  };
}

export function decide(agent: AgentName, p: PythPrice, nowS: number, inv: Inventory, pool: PoolPrice): Decision {
  const age = nowS - p.publishTime;
  if (age > PYTH_MAX_AGE_SECONDS) return hold(`Pyth price is ${age}s old (limit ${PYTH_MAX_AGE_SECONDS}s); refusing to act on stale data`);
  const cb = confBps(p);
  if (cb > PYTH_MAX_CONF_BPS) return hold(`Pyth confidence band is ${cb} bps (limit ${PYTH_MAX_CONF_BPS}); market too uncertain`);

  const dev = deviationBps(p);
  const spendableSol = inv.lamports > SOL_RESERVE_LAMPORTS ? inv.lamports - SOL_RESERVE_LAMPORTS : 0n;
  const canSell = spendableSol >= MIN_SOL_IN;
  const canBuy = inv.usdcUnits >= MIN_USDC_IN;

  if (agent === "PASSIVE") {
    if (dev <= -PASSIVE_BAND_BPS) {
      return canBuy
        ? { action: "BUY", reason: `spot ${dev} bps under EMA: contrarian buy, minimum size`, inputAmount: MIN_USDC_IN }
        : hold(`spot ${dev} bps under EMA but devUSDC balance ${inv.usdcUnits} is below minimum`);
    }
    if (dev >= PASSIVE_BAND_BPS) {
      return canSell
        ? { action: "SELL", reason: `spot ${dev} bps over EMA: contrarian sell, minimum size`, inputAmount: MIN_SOL_IN }
        : hold(`spot ${dev} bps over EMA but spendable SOL ${spendableSol} is below minimum`);
    }
    return hold(`spot ${dev} bps from EMA, inside the +/-${PASSIVE_BAND_BPS} bps band`);
  }

  if (agent === "AGGRESSIVE") {
    const strength = BigInt(Math.min(10, Math.floor(Math.abs(dev) / TREND_BAND_BPS)));
    if (dev >= TREND_BAND_BPS) {
      const size = clamp(MIN_USDC_IN * strength, MIN_USDC_IN, MAX_USDC_IN);
      return canBuy
        ? { action: "BUY", reason: `spot ${dev} bps over EMA: trend buy at ${strength}x size`, inputAmount: size > inv.usdcUnits ? inv.usdcUnits : size }
        : hold(`trend up ${dev} bps but devUSDC balance ${inv.usdcUnits} is below minimum`);
    }
    if (dev <= -TREND_BAND_BPS) {
      const size = clamp(MIN_SOL_IN * strength, MIN_SOL_IN, MAX_SOL_IN);
      return canSell
        ? { action: "SELL", reason: `spot ${dev} bps under EMA: trend sell at ${strength}x size`, inputAmount: size > spendableSol ? spendableSol : size }
        : hold(`trend down ${dev} bps but spendable SOL ${spendableSol} is below minimum`);
    }
    return hold(`spot ${dev} bps from EMA, no trend past +/-${TREND_BAND_BPS} bps`);
  }

  // REBALANCE: value both legs in devUSDC units at the pool's own price.
  const solValue = (spendableSol * pool.usdcUnitsPerSol) / 1_000_000_000n;
  const total = solValue + inv.usdcUnits;
  if (total === 0n) return hold("no inventory to rebalance");
  const solPct = (solValue * 100n) / total;
  const drift = solPct - 50n;
  if (drift > REBALANCE_BAND_PCT) {
    const excessUsdc = (solValue - total / 2n);
    const lamports = clamp((excessUsdc * 1_000_000_000n) / pool.usdcUnitsPerSol, MIN_SOL_IN, MAX_SOL_IN);
    return canSell
      ? { action: "SELL", reason: `SOL is ${solPct}% of value (target 50, band ${REBALANCE_BAND_PCT}): sell SOL back toward target`, inputAmount: lamports > spendableSol ? spendableSol : lamports }
      : hold(`SOL is ${solPct}% of value but spendable SOL is below minimum`);
  }
  if (drift < -REBALANCE_BAND_PCT) {
    const excessUsdc = inv.usdcUnits - total / 2n;
    const units = clamp(excessUsdc, MIN_USDC_IN, MAX_USDC_IN);
    return canBuy
      ? { action: "BUY", reason: `SOL is ${solPct}% of value (target 50, band ${REBALANCE_BAND_PCT}): buy SOL back toward target`, inputAmount: units > inv.usdcUnits ? inv.usdcUnits : units }
      : hold(`SOL is ${solPct}% of value but devUSDC balance is below minimum`);
  }
  return hold(`SOL is ${solPct}% of value, inside 50 +/- ${REBALANCE_BAND_PCT}`);
}
