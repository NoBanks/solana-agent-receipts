use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, instructions::next_policy_head, state::AgentLog};

#[event]
pub struct PolicyUpdated {
    pub agent_log: Pubkey,
    pub policy_hash: [u8; 32],
    pub policy_version: u32,
    /// Receipts attested before this change. Every receipt with seq >= this
    /// ran under the new policy.
    pub at_seq: u64,
    pub head: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump = agent_log.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub agent_log: Account<'info, AgentLog>,
}

pub fn handle_update_policy(ctx: Context<UpdatePolicy>, policy_hash: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let log = &mut ctx.accounts.agent_log;

    log.policy_version = log.policy_version.checked_add(1).unwrap();
    log.policy_hash = policy_hash;
    log.head = next_policy_head(&log.head, &policy_hash, log.policy_version);
    log.last_at = clock.unix_timestamp;
    log.last_slot = clock.slot;

    emit_cpi!(PolicyUpdated {
        agent_log: log.key(),
        policy_hash,
        policy_version: log.policy_version,
        at_seq: log.count,
        head: log.head,
        slot: clock.slot,
        unix_ts: clock.unix_timestamp,
    });
    Ok(())
}
