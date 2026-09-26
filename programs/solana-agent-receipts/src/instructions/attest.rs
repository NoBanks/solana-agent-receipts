use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{constants::*, error::ErrorCode, instructions::next_receipt_head, state::AgentLog};

#[event]
pub struct ReceiptAttested {
    pub agent_log: Pubkey,
    pub seq: u64,
    pub action: u8,
    pub receipt_hash: [u8; 32],
    pub prev_receipt_hash: [u8; 32],
    pub head: [u8; 32],
    pub policy_version: u32,
    pub slot: u64,
    pub unix_ts: i64,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Attest<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump = agent_log.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub agent_log: Account<'info, AgentLog>,
    /// CHECK: the instructions sysvar, address-checked. Read to prove the
    /// receipt's action matches what the same transaction actually did.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Does any other top-level instruction in this transaction call `venue` with
/// `authority` as a signer? That is the agent's own swap.
fn tx_has_venue_call(ix_sysvar: &AccountInfo, venue: &Pubkey, authority: &Pubkey) -> Result<(bool, bool)> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    let mut any_venue = false;
    let mut signed_by_agent = false;
    let mut i = 0usize;
    // load_instruction_at_checked errors past the last instruction; that ends the scan.
    while let Ok(ix) = load_instruction_at_checked(i, ix_sysvar) {
        if i != current && ix.program_id == *venue {
            any_venue = true;
            if ix.accounts.iter().any(|m| m.pubkey == *authority && m.is_signer) {
                signed_by_agent = true;
            }
        }
        i += 1;
    }
    Ok((any_venue, signed_by_agent))
}

pub fn handle_attest(
    ctx: Context<Attest>,
    receipt_hash: [u8; 32],
    expected_seq: u64,
    action: u8,
) -> Result<()> {
    require!(receipt_hash != [0u8; 32], ErrorCode::EmptyReceipt);
    require!(action <= ACTION_SELL, ErrorCode::InvalidAction);

    let log = &ctx.accounts.agent_log;
    // The client states the position it signed for. A stale or racing writer
    // fails here instead of silently landing out of order.
    require!(expected_seq == log.count, ErrorCode::SequenceMismatch);

    let (any_venue, signed_by_agent) = tx_has_venue_call(
        &ctx.accounts.instructions.to_account_info(),
        &log.venue,
        &log.authority,
    )?;
    if action == ACTION_HOLD {
        // A HOLD cannot hide a trade.
        require!(!any_venue, ErrorCode::HoldWithTrade);
    } else {
        // A BUY/SELL cannot be claimed without the trade landing in the same
        // transaction. If the swap fails, the whole transaction, receipt
        // included, fails with it.
        require!(any_venue, ErrorCode::TradeMissing);
        require!(signed_by_agent, ErrorCode::VenueSignerMismatch);
    }

    let clock = Clock::get()?;
    let log = &mut ctx.accounts.agent_log;
    let prev = log.last_receipt;
    log.head = next_receipt_head(&log.head, &receipt_hash, expected_seq, action);
    log.last_receipt = receipt_hash;
    log.count = expected_seq.checked_add(1).unwrap();
    log.last_at = clock.unix_timestamp;
    log.last_slot = clock.slot;

    emit_cpi!(ReceiptAttested {
        agent_log: log.key(),
        seq: expected_seq,
        action,
        receipt_hash,
        prev_receipt_hash: prev,
        head: log.head,
        policy_version: log.policy_version,
        slot: clock.slot,
        unix_ts: clock.unix_timestamp,
    });
    Ok(())
}
