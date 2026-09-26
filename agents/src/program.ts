/**
 * program.ts - client for the solana_agent_receipts program, written against
 * @solana/kit directly. Discriminators and the program id come from the IDL
 * that `anchor build` emits; nothing is hand-copied.
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type GetAccountInfoApi,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
} from "@solana/kit";
import { IDL, PROGRAM_ID } from "./config.js";

export const ACTION = { HOLD: 0, BUY: 1, SELL: 2 } as const;
export type ActionName = keyof typeof ACTION;

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

function disc(kind: "instructions" | "accounts" | "events", name: string): Buffer {
  const hit = IDL[kind].find((x: { name: string }) => x.name === name);
  if (!hit) throw new Error(`${name} not in IDL ${kind}`);
  return Buffer.from(hit.discriminator);
}

function constBytes(name: string): Buffer {
  const hit = IDL.constants.find((c: { name: string }) => c.name === name);
  if (!hit) throw new Error(`constant ${name} not in IDL`);
  // byte-slice constants are rendered as "[65, 71, ...]"
  return Buffer.from(JSON.parse(hit.value));
}

export const AGENT_SEED = constBytes("AGENT_SEED");
export const HEAD_DOMAIN_RECEIPT = constBytes("HEAD_DOMAIN_RECEIPT");
export const HEAD_DOMAIN_POLICY = constBytes("HEAD_DOMAIN_POLICY");

export async function agentLogAddress(authority: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [AGENT_SEED, getAddressEncoder().encode(authority)],
  });
  return pda;
}

export async function eventAuthority(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: ["__event_authority"] });
  return pda;
}

export function name32(name: string): Buffer {
  const b = Buffer.alloc(32);
  b.write(name, "ascii");
  return b;
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export async function registerAgentIx(
  payer: KeyPairSigner,
  authority: KeyPairSigner,
  name: string,
  venue: Address,
  policyHash: Buffer,
): Promise<Instruction> {
  const data = Buffer.concat([disc("instructions", "register_agent"), name32(name), Buffer.from(getAddressEncoder().encode(venue)), policyHash]);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
      { address: await agentLogAddress(authority.address), role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: await eventAuthority(), role: AccountRole.READONLY },
      { address: PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
}

export async function attestIx(authority: KeyPairSigner, receiptHashHex: string, seq: bigint, action: ActionName): Promise<Instruction> {
  const data = Buffer.concat([
    disc("instructions", "attest"),
    Buffer.from(receiptHashHex, "hex"),
    u64le(seq),
    Buffer.from([ACTION[action]]),
  ]);
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
      { address: await agentLogAddress(authority.address), role: AccountRole.WRITABLE },
      { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY },
      { address: await eventAuthority(), role: AccountRole.READONLY },
      { address: PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
}

export type AgentLog = {
  address: string;
  authority: string;
  venue: string;
  name: string;
  policyHash: string;
  policyVersion: number;
  count: bigint;
  lastReceipt: string;
  head: string;
  createdAt: number;
  lastAt: number;
  lastSlot: bigint;
};

export async function fetchAgentLog(rpc: Rpc<GetAccountInfoApi>, authority: Address): Promise<AgentLog | null> {
  const pda = await agentLogAddress(authority);
  const res = await rpc.getAccountInfo(pda, { encoding: "base64", commitment: "confirmed" }).send();
  if (!res.value) return null;
  const b = Buffer.from(res.value.data[0], "base64");
  if (!b.subarray(0, 8).equals(disc("accounts", "AgentLog"))) throw new Error(`${pda} is not an AgentLog`);
  const addr = (o: number) => base58(b.subarray(o, o + 32));
  let o = 8;
  const log: AgentLog = {
    address: String(pda),
    authority: addr(o),
    venue: addr((o += 32)),
    name: b.subarray((o += 32), o + 32).toString("ascii").replace(/\0+$/, ""),
    policyHash: b.subarray((o += 32), o + 32).toString("hex"),
    policyVersion: b.readUInt32LE((o += 32)),
    count: b.readBigUInt64LE((o += 4)),
    lastReceipt: b.subarray((o += 8), o + 32).toString("hex"),
    head: b.subarray((o += 32), o + 32).toString("hex"),
    createdAt: Number(b.readBigInt64LE((o += 32))),
    lastAt: Number(b.readBigInt64LE((o += 8))),
    lastSlot: b.readBigUInt64LE((o += 8)),
  };
  return log;
}

export function base58(bytes: Uint8Array): string {
  return String(getAddressDecoder().decode(bytes));
}

// ---- the head, recomputed off chain (must match instructions.rs) ----

export function nextPolicyHead(headHex: string, policyHashHex: string, version: number): string {
  return createHash("sha256")
    .update(HEAD_DOMAIN_POLICY)
    .update(Buffer.from(headHex, "hex"))
    .update(Buffer.from(policyHashHex, "hex"))
    .update(u32le(version))
    .digest("hex");
}

export function nextReceiptHead(headHex: string, receiptHashHex: string, seq: bigint, action: ActionName): string {
  return createHash("sha256")
    .update(HEAD_DOMAIN_RECEIPT)
    .update(Buffer.from(headHex, "hex"))
    .update(Buffer.from(receiptHashHex, "hex"))
    .update(u64le(seq))
    .update(Buffer.from([ACTION[action]]))
    .digest("hex");
}

export const ZERO32 = "00".repeat(32);

/** Decode a ReceiptAttested event from emit_cpi! inner-instruction data. */
export function decodeReceiptAttested(data: Buffer) {
  // emit_cpi data = 8-byte EVENT_IX_TAG + 8-byte event discriminator + borsh body
  if (!data.subarray(8, 16).equals(disc("events", "ReceiptAttested"))) return null;
  let o = 16;
  const agentLog = base58(data.subarray(o, (o += 32)));
  const seq = data.readBigUInt64LE(o); o += 8;
  const action = data[o]; o += 1;
  const receiptHash = data.subarray(o, (o += 32)).toString("hex");
  const prevReceiptHash = data.subarray(o, (o += 32)).toString("hex");
  const head = data.subarray(o, (o += 32)).toString("hex");
  const policyVersion = data.readUInt32LE(o); o += 4;
  const slot = data.readBigUInt64LE(o); o += 8;
  const unixTs = Number(data.readBigInt64LE(o));
  return { agentLog, seq, action, receiptHash, prevReceiptHash, head, policyVersion, slot, unixTs };
}
