// Measures how often Pyth's sponsored SOL/USD account actually updates on the chosen cluster.
// Used to set PYTH_MAX_AGE_SECONDS from data instead of a guess.
import { createSolanaRpc } from "@solana/kit";
import { readPyth } from "../src/pyth.js";
import { PYTH_SOL_USD, RPC_URL } from "../src/config.js";
const rpc = createSolanaRpc(RPC_URL);
const samples = Number(process.argv[2] ?? 30);
let last = 0;
const gaps: number[] = [];
const ages: number[] = [];
for (let i = 0; i < samples; i++) {
  const p = await readPyth(rpc, PYTH_SOL_USD);
  const now = Math.floor(Date.now() / 1000);
  ages.push(now - p.publishTime);
  if (last && p.publishTime !== last) gaps.push(p.publishTime - last);
  last = p.publishTime;
  await new Promise((r) => setTimeout(r, 10000));
}
ages.sort((a, b) => a - b);
console.log(JSON.stringify({ samples, update_gaps_s: gaps, age_min: ages[0], age_median: ages[Math.floor(ages.length / 2)], age_max: ages[ages.length - 1] }));
