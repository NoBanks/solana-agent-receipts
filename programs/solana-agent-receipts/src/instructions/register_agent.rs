use anchor_lang::prelude::*;

use crate::{constants::*, instructions::next_policy_head, state::AgentLog};

#[event]
pub struct AgentRegistered {
    pub agent_log: Pubkey,
    pub authority: Pubkey,
    pub venue: Pubkey,
    pub name: [u8; 32],
    pub policy_hash: [u8; 32],
    pub head: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The agent's own wallet. Signs every future attest.
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + AgentLog::INIT_SPACE,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump
    )]
    pub agent_log: Account<'info, AgentLog>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_agent(
    ctx: Context<RegisterAgent>,
    name: [u8; 32],
    venue: Pubkey,
    policy_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let log = &mut ctx.accounts.agent_log;

    log.authority = ctx.accounts.authority.key();
    log.venue = venue;
    log.name = name;
    log.policy_hash = policy_hash;
    log.policy_version = 1;
    log.count = 0;
    log.last_receipt = [0u8; 32];
    // The genesis head already commits to the policy the agent started under.
    log.head = next_policy_head(&[0u8; 32], &policy_hash, 1);
    log.created_at = clock.unix_timestamp;
    log.last_at = clock.unix_timestamp;
    log.last_slot = clock.slot;
    log.bump = ctx.bumps.agent_log;

    emit_cpi!(AgentRegistered {
        agent_log: log.key(),
        authority: log.authority,
        venue,
        name,
        policy_hash,
        head: log.head,
        slot: clock.slot,
        unix_ts: clock.unix_timestamp,
    });
    Ok(())
}
