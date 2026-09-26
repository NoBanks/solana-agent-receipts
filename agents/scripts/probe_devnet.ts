// Read-only probe: confirms the devnet pool and the Pyth account before any agent touches them.
import { createSolanaRpc, address } from "@solana/kit";
import { WhirlpoolDeployment, fetchWhirlpool } from "@orca-so/whirlpools-client";

const rpc = createSolanaRpc("https://api.devnet.solana.com");
console.log("devnet deployment", WhirlpoolDeployment.devnet);
for (const p of ["3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt", "2WUgXbAmhquXMLhqqUthztDaVYnG8Mmp57CkXNb5ym9G"]) {
  const w = await fetchWhirlpool(rpc, address(p));
  const d = w.data;
  console.log(p, { mintA: d.tokenMintA, mintB: d.tokenMintB, tickSpacing: d.tickSpacing, liquidity: d.liquidity.toString(), sqrtPrice: d.sqrtPrice.toString(), config: d.whirlpoolsConfig, feeRate: d.feeRate });
  for (const v of [d.tokenVaultA, d.tokenVaultB]) {
    const b = await rpc.getTokenAccountBalance(v).send();
    console.log("  vault", v, b.value.uiAmountString);
  }
}
const acct = await rpc.getAccountInfo(address("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"), { encoding: "base64" }).send();
console.log("pyth owner", acct.value?.owner, "len", Buffer.from(acct.value!.data[0], "base64").length);
