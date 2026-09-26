use anchor_lang::prelude::*;

/// One per agent. Holds O(1) state no matter how many receipts the agent writes:
/// the full history is committed by `head`, and each receipt's bytes live in the
/// agent's off-chain ledger and in the event of the transaction that attested it.
#[account]
#[derive(InitSpace)]
pub struct AgentLog {
    /// The only key allowed to attest. The agent's own wallet, never a shared operator.
    pub authority: Pubkey,
    /// Program the agent trades on. BUY/SELL receipts must sit in a transaction
    /// that calls it; HOLD receipts must not.
    pub venue: Pubkey,
    /// Human-readable name, zero padded.
    pub name: [u8; 32],
    /// sha256 of the agent's published strategy/config. Changing it is itself
    /// folded into `head`, so a silent strategy swap is visible.
    pub policy_hash: [u8; 32],
    pub policy_version: u32,
    /// Number of receipts attested. The next receipt must claim this as its seq.
    pub count: u64,
    pub last_receipt: [u8; 32],
    /// Rolling commitment over every receipt and policy change, in order.
    /// Recompute it from the ledger; if it matches, nothing was dropped,
    /// reordered, edited or inserted.
    pub head: [u8; 32],
    pub created_at: i64,
    pub last_at: i64,
    pub last_slot: u64,
    pub bump: u8,
}
