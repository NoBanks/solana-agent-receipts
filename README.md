# Agent Receipts on Solana

**Autonomous agents that cannot lie about what they did.**

Live on devnet: **https://solana-receipts.nohumannearby.com** (heads, receipts and raw ledgers, read live)
Program: `GkCqpfzoMVSCMw4muiKAXoo4kcHFRiYjjAHBQjmhMwmU` (devnet)

AI agents are starting to move money. When one trades, you get a log file the
operator controls. Logs can be edited, trimmed and backfilled after the fact,
and "the agent decided X because Y" is a claim, not evidence.

Agent Receipts turns every agent decision into a receipt that is checked by a
Solana program at the moment the decision executes:

- **A trade and its receipt land in the same transaction.** The program reads
  the instructions sysvar: a `BUY`/`SELL` receipt is rejected unless the agent's
  own swap on its registered venue is in the same transaction, and a `HOLD`
  receipt is rejected if one is. If the swap fails, the receipt fails with it.
- **The whole history is committed in 32 bytes.** Each agent has one small
  account whose `head` is a rolling sha256 over every receipt and every strategy
  change, in order. Recompute it from the public ledger and compare. One dropped,
  edited, reordered or inserted receipt and it no longer matches.
- **Receipts are numbered by the chain.** `attest` takes the sequence number the
  agent signed for and rejects anything else, so a stale or racing writer fails
  loudly instead of landing out of order.
- **The strategy is committed too.** The sha256 of the agent's policy (its
  thresholds and sizes) is set at registration and folded into the head. Changing
  it is an on-chain event, so a silent strategy swap is visible.
- **O(1) cost.** No account per receipt, no rent that grows with history. An
  attest costs one transaction fee.

The first users are three TRAIDE trading agents on devnet. They read the real
SOL/USD price from Pyth's on-chain account, trade on Orca Whirlpools, and
receipt every decision, trades and holds alike.

## Layout

```
programs/solana-agent-receipts   Anchor program (Rust) + litesvm tests
idl/                             IDL emitted by anchor build
agents/src/runner.ts             the three agents (Pyth -> decide -> Orca swap + attest, one tx)
agents/src/verify.ts             re-derives every claim from public data, no keys
agents/src/canonical.ts          receipt hashing rule, byte-identical to the Python one in traide-arc-agents
```

## The program

| Instruction | What it does |
|---|---|
| `register_agent(name, venue, policy_hash)` | Creates the agent's log PDA `["agent", authority]`. Genesis head commits to the policy. |
| `attest(receipt_hash, expected_seq, action)` | Checks the sequence, checks the transaction against the action, advances the head, emits `ReceiptAttested` via `emit_cpi!`. |
| `update_policy(policy_hash)` | Records a strategy change in the head and emits `PolicyUpdated`. |

Head step, identical in Rust (`instructions.rs`) and TypeScript (`program.ts`):

```
receipt: head' = sha256("AGENT-RECEIPTS/v1/receipt" || head || receipt_hash || seq_u64_le || action_u8)
policy:  head' = sha256("AGENT-RECEIPTS/v1/policy"  || head || policy_hash  || version_u32_le)
```

Any program can use it: register an agent, put your swap (or any venue call)
and `attest` in one transaction.

## Run it

Build and test the program (SBPF v0 on purpose, see `build.sh`):

```bash
./build.sh
cargo test          # 11 tests: chaining, sequence, trade/no-trade checks, signer checks, policy changes
```

Run the agents (keys are standard solana-keygen files in `~/.config/solana-agent-receipts/`,
named deployer / passive / aggressive / rebalance):

```bash
cd agents && npm install
npx tsx src/runner.ts register
npx tsx src/runner.ts loop
```

Run everything under PM2 (runner, page, tunnel; crash-loop guards included) with
`ecosystem.config.cjs`.

Verify an agent from public data only:

```bash
npx tsx src/verify.ts <agent address> <ledger.jsonl or URL> --tx all
```

It checks that every receipt re-hashes, the rows link, the replayed head equals
the on-chain head, the on-chain count equals the rows, and every transaction
carries the matching `ReceiptAttested` event and (for trades) the agent's own
Orca swap.

## Day one: the verifier caught our own bug

On 2026-09-27 the public page showed AGGRESSIVE with 1 receipt on chain and 0 in its ledger. The
runner had sent the transaction, the RPC answered the *confirmation* call with HTTP 429, and the
runner logged a landed receipt as failed, dropping its body. That is exactly the kind of gap the
head exists to expose, and it did, within minutes.

The fix is in `runner.ts`: every receipt is written to `<agent>.pending.json` before its transaction
is sent, a send error is settled by asking the chain (`getSignatureStatuses`), the next cycle
reconciles anything left pending, and the runner refuses to write past a ledger gap. The orphaned
agent key was retired and its log left on chain untouched
(`RmfixAqApamW2ghty3x8oCoTDT2PbWCEsjSWsukzbws`); AGGRESSIVE restarted under a new key.

## Policy changes are on chain too

Pyth's sponsored SOL/USD account on devnet updates about every 634 seconds (measured with
`agents/scripts/pyth_cadence.ts`), so the original 120 s freshness limit made the agents refuse
most cycles. The limit moved to 900 s, and each agent committed the new policy with
`update_policy` (policy v2). `verify.ts` replays those changes into the head at the exact sequence
where they happened. Every receipt also records the price's publish time, so its real age is visible.

## What the numbers mean

The signal is the real SOL/USD market read from Pyth. Execution happens in an
Orca devnet pool whose price is set by devnet liquidity, not the market. Every
receipt records both, so nobody mistakes one for the other. This is devnet
evidence that the mechanism works, not a trading performance claim.

## License

MIT
