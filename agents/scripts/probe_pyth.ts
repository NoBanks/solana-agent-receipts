import { createSolanaRpc, address } from "@solana/kit";
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const a = await rpc.getAccountInfo(address("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"), { encoding: "base64" }).send();
const b = Buffer.from(a.value!.data[0], "base64");
console.log("disc", b.subarray(0, 8).toString("hex"), "tag", b[40], "next", b[41]);
const o = b[40] === 0 ? 42 : 41;
console.log("feed", b.subarray(o, o + 32).toString("hex"));
console.log("price", b.readBigInt64LE(o + 32), "conf", b.readBigUInt64LE(o + 40), "expo", b.readInt32LE(o + 48),
  "publish", new Date(Number(b.readBigInt64LE(o + 52)) * 1000).toISOString(), "ema", b.readBigInt64LE(o + 68), "slot", b.readBigUInt64LE(o + 84));
