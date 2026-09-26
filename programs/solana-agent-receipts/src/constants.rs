use anchor_lang::prelude::*;

/// PDA seed for an agent's log: ["agent", authority].
#[constant]
pub const AGENT_SEED: &[u8] = b"agent";

/// Domain tag mixed into every chain-head step so a head from this program can
/// never collide with a hash computed for some other purpose. Bump the digit if
/// the head formula ever changes; verifiers key off it.
#[constant]
pub const HEAD_DOMAIN_RECEIPT: &[u8] = b"AGENT-RECEIPTS/v1/receipt";

#[constant]
pub const HEAD_DOMAIN_POLICY: &[u8] = b"AGENT-RECEIPTS/v1/policy";

/// Receipt actions. HOLD must not trade; BUY and SELL must trade.
#[constant]
pub const ACTION_HOLD: u8 = 0;
#[constant]
pub const ACTION_BUY: u8 = 1;
#[constant]
pub const ACTION_SELL: u8 = 2;
