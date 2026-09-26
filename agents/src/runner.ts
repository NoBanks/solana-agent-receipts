/**
 * runner.ts - one decision per agent per cycle, each one receipted on chain.
 *
 *   npx tsx src/runner.ts register        register the three agents (once)
 *   npx tsx src/runner.ts once            run one cycle for every agent
 *   npx tsx src/runner.ts loop            run forever, CYCLE_SECONDS apart
 *
 * A cycle: read Pyth SOL/USD from chain, read the Orca pool and the agent's own
 * balances, decide, and if the decision is a trade, get an Orca quote. Build the
 * receipt from those numbers, hash it, then send ONE transaction holding the
 * swap (if any) and the attest instruction. The program checks the transaction
 * matches the receipt's action, so a trade and its receipt land together or
 * not at all.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { swapInstructions } from "@orca-so/whirlpools";
import { WhirlpoolDeployment, fetchWhirlpool } from "@orca-so/whirlpools-client";
import {
  AGENTS, CLUSTER, CYCLE_SECONDS, DEV_USDC_MINT, LEDGER_DIR, ORCA_WHIRLPOOL_PROGRAM, POOL, PROGRAM_ID,
  PYTH_SOL_USD, RPC_URL, SLIPPAGE_BPS, WSOL_MINT, explorerTx, type AgentName,
} from "./config.js";
import { canonicalBytes, receiptHash, sha256Hex, type Json } from "./canonical.js";
import { confBps, deviationBps, readPyth } from "./pyth.js";
import { attestIx, fetchAgentLog, registerAgentIx } from "./program.js";
import { decide, policyDocument, type Inventory } from "./strategy.js";
import { appendRow } from "./ledger.js";
import { loadSigner } from "./wallets.js";

const RECEIPT_TYPE = "solana_agent_decision";
const ENGINE = "solana-agent-receipts";
const ENGINE_VERSION = "0.1.0";

const rpc = createSolanaRpc(RPC_URL);
const wsUrl = process.env.WS_URL ?? RPC_URL.replace(/^http/, "ws").replace(":8899", ":8900");
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const deployment = WhirlpoolDeployment.devnet;

export function policyHashFor(agent: AgentName): Buffer {
  return Buffer.from(sha256Hex(canonicalBytes({ agent, ...policyDocument() } as Json)), "hex");
}

async function send(feePayer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
  return getSignatureFromTransaction(tx);
}

async function inventory(owner: KeyPairSigner): Promise<Inventory> {
  const { value: lamports } = await rpc.getBalance(owner.address, { commitment: "confirmed" }).send();
  const { value: accts } = await rpc
    .getTokenAccountsByOwner(owner.address, { mint: DEV_USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" })
    .send();
  let usdcUnits = 0n;
  for (const a of accts) {
    const info = (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info;
    usdcUnits += BigInt(info.tokenAmount.amount);
  }
  return { lamports: BigInt(lamports), usdcUnits };
}

async function register(): Promise<void> {
  const payer = await loadSigner("deployer");
  for (const agent of AGENTS) {
    const signer = await loadSigner(agent);
    const existing = await fetchAgentLog(rpc, signer.address);
    if (existing) {
      console.log(`${agent} already registered at ${existing.address} (count ${existing.count})`);
      continue;
    }
    const venue = process.env.VENUE_PROGRAM ? address(process.env.VENUE_PROGRAM) : ORCA_WHIRLPOOL_PROGRAM;
    const ix = await registerAgentIx(payer, signer, agent, venue, policyHashFor(agent));
    const sig = await send(payer, [ix]);
    console.log(`${agent} registered: ${explorerTx(sig)}`);
  }
}

async function cycle(agent: AgentName, n: number): Promise<void> {
  const signer = await loadSigner(agent);
  const log = await fetchAgentLog(rpc, signer.address);
  if (!log) throw new Error(`${agent} is not registered; run: npx tsx src/runner.ts register`);

  const pyth = await readPyth(rpc, PYTH_SOL_USD);
  const pool = await fetchWhirlpool(rpc, POOL);
  const sqrt = pool.data.sqrtPrice;
  // devUSDC units per 1 SOL at the pool's current price (A = wSOL, B = devUSDC)
  const usdcUnitsPerSol = (sqrt * sqrt * 1_000_000_000n) >> 128n;
  const inv = await inventory(signer);
  const nowS = Math.floor(Date.now() / 1000);
  const d = decide(agent, pyth, nowS, inv, { usdcUnitsPerSol });

  let swapIxs: Instruction[] = [];
  let swap: Json = {};
  if (d.action !== "HOLD") {
    const inputMint = d.action === "SELL" ? WSOL_MINT : DEV_USDC_MINT;
    const res = await swapInstructions(rpc, { inputAmount: d.inputAmount, mint: inputMint }, POOL, {
      slippageToleranceBps: SLIPPAGE_BPS,
      signer,
      whirlpoolDeployment: deployment,
    });
    swapIxs = res.instructions;
    swap = {
      venue: String(ORCA_WHIRLPOOL_PROGRAM),
      input_mint: String(inputMint),
      output_mint: String(inputMint === WSOL_MINT ? DEV_USDC_MINT : WSOL_MINT),
      input_amount: res.quote.tokenIn.toString(),
      quote_est_out: res.quote.tokenEstOut.toString(),
      quote_min_out: res.quote.tokenMinOut.toString(),
      slippage_bps: SLIPPAGE_BPS,
    };
  }

  const seq = log.count;
  const receipt: Json = {
    type: RECEIPT_TYPE,
    engine: ENGINE,
    engine_version: ENGINE_VERSION,
    cluster: CLUSTER,
    program: String(PROGRAM_ID),
    agent,
    agent_address: String(signer.address),
    agent_log: log.address,
    policy_hash: log.policyHash,
    policy_version: log.policyVersion,
    seq: seq.toString(),
    cycle: n,
    action: d.action,
    reason: d.reason,
    signal: {
      source: "pyth",
      account: pyth.account,
      account_sha256: pyth.accountSha256,
      feed_id: pyth.feedId,
      verification: pyth.verification,
      price: pyth.price.toString(),
      conf: pyth.conf.toString(),
      exponent: pyth.exponent,
      ema_price: pyth.emaPrice.toString(),
      publish_time: pyth.publishTime,
      posted_slot: pyth.postedSlot.toString(),
      read_at_slot: pyth.contextSlot.toString(),
      deviation_bps: deviationBps(pyth),
      conf_bps: confBps(pyth),
    },
    pool: {
      address: String(POOL),
      sqrt_price_x64: sqrt.toString(),
      liquidity: pool.data.liquidity.toString(),
      tick_current: pool.data.tickCurrentIndex,
      usdc_units_per_sol: usdcUnitsPerSol.toString(),
    },
    balances: { lamports: inv.lamports.toString(), dev_usdc_units: inv.usdcUnits.toString() },
    swap,
    timestamp: new Date(nowS * 1000).toISOString().replace(".000Z", "Z"),
  };
  const h = receiptHash(receipt);
  const ix = await attestIx(signer, h, seq, d.action);

  try {
    const sig = await send(signer, [...swapIxs, ix]);
    appendRow(agent, {
      seq: seq.toString(),
      action: d.action,
      receipt_hash: h,
      prev_receipt_hash: log.lastReceipt,
      signature: sig,
      receipt,
    });
    console.log(`${agent} #${seq} ${d.action} ${h.slice(0, 12)} ${explorerTx(sig)} | ${d.reason}`);
  } catch (e) {
    // Nothing was attested, so nothing enters the ledger. Record why, outside the chain.
    mkdirSync(LEDGER_DIR, { recursive: true });
    appendFileSync(
      join(LEDGER_DIR, "failed_attempts.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), agent, seq: seq.toString(), action: d.action, receipt_hash: h, error: String(e).slice(0, 500) }) + "\n",
    );
    console.error(`${agent} #${seq} ${d.action} FAILED, not attested: ${String(e).slice(0, 200)}`);
  }
}

async function runOnce(n: number): Promise<void> {
  for (const agent of AGENTS) {
    try {
      await cycle(agent, n);
    } catch (e) {
      console.error(`${agent} cycle error: ${String(e).slice(0, 300)}`);
    }
  }
}

const cmd = process.argv[2] ?? "once";
if (cmd === "register") await register();
else if (cmd === "once") await runOnce(0);
else if (cmd === "loop") {
  for (let n = 0; ; n++) {
    await runOnce(n);
    await new Promise((r) => setTimeout(r, CYCLE_SECONDS * 1000));
  }
} else {
  console.error("usage: runner.ts register | once | loop");
  process.exit(2);
}
process.exit(0);
