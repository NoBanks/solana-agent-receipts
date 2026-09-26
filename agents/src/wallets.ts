/**
 * wallets.ts - each agent signs with its own key, never a shared operator.
 * Keys live outside the repo (AGENT_KEY_DIR, default ~/.config/solana-agent-receipts)
 * as standard solana-keygen JSON files. Their contents are never logged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { KEY_DIR } from "./config.js";

export async function loadSigner(name: string): Promise<KeyPairSigner> {
  const raw = JSON.parse(readFileSync(join(KEY_DIR, `${name.toLowerCase()}.json`), "utf8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}
