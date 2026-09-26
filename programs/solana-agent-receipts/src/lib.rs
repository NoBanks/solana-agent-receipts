pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("GkCqpfzoMVSCMw4muiKAXoo4kcHFRiYjjAHBQjmhMwmU");

/// Agent Receipts: tamper-evident, hash-chained decision receipts for
/// autonomous agents.
///
/// Every decision an agent makes (trade or hold) is hashed off chain and
/// attested here by the agent's own key. The program keeps one small account
/// per agent whose `head` commits to the whole ordered history, and it checks
/// the transaction itself so a BUY/SELL receipt cannot exist without its swap
/// and a HOLD cannot hide one.
#[program]
pub mod solana_agent_receipts {
    use super::*;

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: [u8; 32],
        venue: Pubkey,
        policy_hash: [u8; 32],
    ) -> Result<()> {
        crate::instructions::register_agent::handle_register_agent(ctx, name, venue, policy_hash)
    }

    pub fn attest(
        ctx: Context<Attest>,
        receipt_hash: [u8; 32],
        expected_seq: u64,
        action: u8,
    ) -> Result<()> {
        crate::instructions::attest::handle_attest(ctx, receipt_hash, expected_seq, action)
    }

    pub fn update_policy(ctx: Context<UpdatePolicy>, policy_hash: [u8; 32]) -> Result<()> {
        crate::instructions::update_policy::handle_update_policy(ctx, policy_hash)
    }
}
