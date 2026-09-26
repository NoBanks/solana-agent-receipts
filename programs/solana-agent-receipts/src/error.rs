use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the agent's own authority can write to its log")]
    Unauthorized,
    #[msg("expected_seq does not match the log's next sequence number")]
    SequenceMismatch,
    #[msg("Unknown action code")]
    InvalidAction,
    #[msg("A BUY or SELL receipt needs a swap on the agent's venue earlier in the same transaction")]
    TradeMissing,
    #[msg("A HOLD receipt cannot share a transaction with a swap on the agent's venue")]
    HoldWithTrade,
    #[msg("The venue instruction must be signed by the agent's authority")]
    VenueSignerMismatch,
    #[msg("Receipt hash must not be all zeroes")]
    EmptyReceipt,
}
