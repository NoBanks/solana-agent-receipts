/**
 * Lists every account a real Orca swap on the devnet pool touches, so a local
 * validator can clone exactly those from devnet. Read-only against devnet.
 * Uses a throwaway signer: nothing is signed or sent.
 */
import { createSolanaRpc, generateKeyPairSigner } from "@solana/kit";
import { swapInstructions, setEnforceTokenBalanceCheck } from "@orca-so/whirlpools";
import { WhirlpoolDeployment } from "@orca-so/whirlpools-client";
import { POOL, WSOL_MINT, DEV_USDC_MINT, PYTH_SOL_USD } from "../src/config.js";

setEnforceTokenBalanceCheck(false);
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const signer = await generateKeyPairSigner();
const seen = new Set<string>([String(POOL), String(PYTH_SOL_USD), String(DEV_USDC_MINT)]);
for (const mint of [WSOL_MINT, DEV_USDC_MINT]) {
  const res = await swapInstructions(rpc, { inputAmount: 10_000_000n, mint }, POOL, { signer, whirlpoolDeployment: WhirlpoolDeployment.devnet });
  for (const ix of res.instructions) for (const a of ix.accounts ?? []) seen.add(String(a.address));
}
const out: string[] = [];
for (const a of seen) {
  if (a === String(signer.address)) continue;
  const info = await rpc.getAccountInfo(a as never, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send();
  if (!info.value) continue; // the agent's own ATAs etc. do not exist yet
  out.push(`${a} ${info.value.executable ? "program" : "account"} ${info.value.owner}`);
}
console.log(out.join("\n"));
