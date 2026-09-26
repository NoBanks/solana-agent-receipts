pub mod attest;
pub mod register_agent;
pub mod update_policy;

pub use attest::*;
pub use register_agent::*;
pub use update_policy::*;

use crate::constants::*;

/// One step of the rolling commitment over a receipt:
///   head' = sha256(HEAD_DOMAIN_RECEIPT || head || receipt_hash || seq_le_u64 || action)
/// Verifiers recompute this from the ledger; see verifier/ in the repo root.
pub fn next_receipt_head(head: &[u8; 32], receipt_hash: &[u8; 32], seq: u64, action: u8) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        HEAD_DOMAIN_RECEIPT,
        head,
        receipt_hash,
        &seq.to_le_bytes(),
        &[action],
    ])
    .to_bytes()
}

/// One step of the rolling commitment over a policy change:
///   head' = sha256(HEAD_DOMAIN_POLICY || head || policy_hash || version_le_u32)
pub fn next_policy_head(head: &[u8; 32], policy_hash: &[u8; 32], version: u32) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        HEAD_DOMAIN_POLICY,
        head,
        policy_hash,
        &version.to_le_bytes(),
    ])
    .to_bytes()
}
