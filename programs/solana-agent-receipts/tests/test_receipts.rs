use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_agent_receipts::{
        constants::*, instructions::{next_policy_head, next_receipt_head}, state::AgentLog,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const IX_SYSVAR: Pubkey = solana_instructions_sysvar::ID;

struct Env {
    svm: LiteSVM,
    program_id: Pubkey,
    event_authority: Pubkey,
}

fn setup() -> Env {
    let program_id = solana_agent_receipts::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/solana_agent_receipts.so"
    ));
    svm.add_program(program_id, bytes).unwrap();
    let event_authority = Pubkey::find_program_address(&[b"__event_authority"], &program_id).0;
    Env { svm, program_id, event_authority }
}

fn agent_pda(env: &Env, authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[AGENT_SEED, authority.as_ref()], &env.program_id).0
}

fn send(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    env.svm.expire_blockhash();
    let blockhash = env.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    env.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err) + &e.meta.logs.join("\n"))
}

fn read_log(env: &Env, pda: &Pubkey) -> AgentLog {
    let acc = env.svm.get_account(pda).unwrap();
    let mut data: &[u8] = &acc.data;
    AgentLog::try_deserialize(&mut data).unwrap()
}

fn name32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

fn register_ix(env: &Env, payer: &Pubkey, authority: &Pubkey, venue: Pubkey, policy: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        env.program_id,
        &solana_agent_receipts::instruction::RegisterAgent { name: name32("PASSIVE"), venue, policy_hash: policy }.data(),
        solana_agent_receipts::accounts::RegisterAgent {
            payer: *payer,
            authority: *authority,
            agent_log: agent_pda(env, authority),
            system_program: system_program::ID,
            event_authority: env.event_authority,
            program: env.program_id,
        }
        .to_account_metas(None),
    )
}

fn attest_ix(env: &Env, authority: &Pubkey, log: Pubkey, hash: [u8; 32], seq: u64, action: u8) -> Instruction {
    Instruction::new_with_bytes(
        env.program_id,
        &solana_agent_receipts::instruction::Attest { receipt_hash: hash, expected_seq: seq, action }.data(),
        solana_agent_receipts::accounts::Attest {
            authority: *authority,
            agent_log: log,
            instructions: IX_SYSVAR,
            event_authority: env.event_authority,
            program: env.program_id,
        }
        .to_account_metas(None),
    )
}

/// The test venue is the System Program: a transfer signed by the agent stands
/// in for "the agent's swap". The program only checks program id + signer, so
/// this exercises exactly the same code path an Orca swap does on devnet.
fn venue_call(from: &Pubkey) -> Instruction {
    system_instruction::transfer(from, &Pubkey::new_unique(), 1_000)
}

/// Registers one agent whose venue is the System Program.
fn registered(env: &mut Env) -> (Keypair, Pubkey, [u8; 32]) {
    let agent = Keypair::new();
    env.svm.airdrop(&agent.pubkey(), 10_000_000_000).unwrap();
    let policy = [7u8; 32];
    let ix = register_ix(env, &agent.pubkey(), &agent.pubkey(), system_program::ID, policy);
    send(env, &[ix], &[&agent]).unwrap();
    let pda = agent_pda(env, &agent.pubkey());
    (agent, pda, policy)
}

#[test]
fn register_commits_policy_in_genesis_head() {
    let mut env = setup();
    let (agent, pda, policy) = registered(&mut env);
    let log = read_log(&env, &pda);
    assert_eq!(log.authority, agent.pubkey());
    assert_eq!(log.venue, system_program::ID);
    assert_eq!(log.count, 0);
    assert_eq!(log.policy_version, 1);
    assert_eq!(log.head, next_policy_head(&[0u8; 32], &policy, 1));
}

#[test]
fn hold_receipts_chain_and_head_is_recomputable() {
    let mut env = setup();
    let (agent, pda, policy) = registered(&mut env);
    let mut expected = next_policy_head(&[0u8; 32], &policy, 1);
    for seq in 0..5u64 {
        let h = [seq as u8 + 1; 32];
        let ix = attest_ix(&env, &agent.pubkey(), pda, h, seq, ACTION_HOLD);
        send(&mut env, &[ix], &[&agent]).unwrap();
        expected = next_receipt_head(&expected, &h, seq, ACTION_HOLD);
    }
    let log = read_log(&env, &pda);
    assert_eq!(log.count, 5);
    assert_eq!(log.last_receipt, [5u8; 32]);
    assert_eq!(log.head, expected, "off-chain recompute must equal on-chain head");
}

#[test]
fn wrong_or_replayed_sequence_is_rejected() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    let ok = attest_ix(&env, &agent.pubkey(), pda, [1u8; 32], 0, ACTION_HOLD);
    send(&mut env, &[ok], &[&agent]).unwrap();
    // replaying seq 0
    let replay = attest_ix(&env, &agent.pubkey(), pda, [2u8; 32], 0, ACTION_HOLD);
    let err = send(&mut env, &[replay], &[&agent]).unwrap_err();
    assert!(err.contains("SequenceMismatch"), "{err}");
    // skipping ahead
    let skip = attest_ix(&env, &agent.pubkey(), pda, [2u8; 32], 5, ACTION_HOLD);
    let err = send(&mut env, &[skip], &[&agent]).unwrap_err();
    assert!(err.contains("SequenceMismatch"), "{err}");
    assert_eq!(read_log(&env, &pda).count, 1);
}

#[test]
fn buy_without_a_swap_in_the_same_tx_is_rejected() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    let ix = attest_ix(&env, &agent.pubkey(), pda, [1u8; 32], 0, ACTION_BUY);
    let err = send(&mut env, &[ix], &[&agent]).unwrap_err();
    assert!(err.contains("TradeMissing"), "{err}");
}

#[test]
fn buy_with_the_agents_own_swap_is_accepted() {
    let mut env = setup();
    let (agent, pda, policy) = registered(&mut env);
    let swap = venue_call(&agent.pubkey());
    let ix = attest_ix(&env, &agent.pubkey(), pda, [9u8; 32], 0, ACTION_BUY);
    send(&mut env, &[swap, ix], &[&agent]).unwrap();
    let log = read_log(&env, &pda);
    assert_eq!(log.count, 1);
    let genesis = next_policy_head(&[0u8; 32], &policy, 1);
    assert_eq!(log.head, next_receipt_head(&genesis, &[9u8; 32], 0, ACTION_BUY));
}

#[test]
fn sell_with_someone_elses_swap_is_rejected() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let their_swap = venue_call(&stranger.pubkey());
    let ix = attest_ix(&env, &agent.pubkey(), pda, [3u8; 32], 0, ACTION_SELL);
    let err = send(&mut env, &[their_swap, ix], &[&agent, &stranger]).unwrap_err();
    assert!(err.contains("VenueSignerMismatch"), "{err}");
}

#[test]
fn hold_cannot_hide_a_trade() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    let swap = venue_call(&agent.pubkey());
    let ix = attest_ix(&env, &agent.pubkey(), pda, [4u8; 32], 0, ACTION_HOLD);
    let err = send(&mut env, &[swap, ix], &[&agent]).unwrap_err();
    assert!(err.contains("HoldWithTrade"), "{err}");
}

#[test]
fn a_failed_swap_takes_the_receipt_down_with_it() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    // a transfer bigger than the balance fails, so the whole tx must fail
    let broke = system_instruction::transfer(&agent.pubkey(), &Pubkey::new_unique(), u64::MAX / 2);
    let ix = attest_ix(&env, &agent.pubkey(), pda, [5u8; 32], 0, ACTION_BUY);
    assert!(send(&mut env, &[broke, ix], &[&agent]).is_err());
    assert_eq!(read_log(&env, &pda).count, 0, "no receipt for a trade that did not happen");
}

#[test]
fn only_the_agent_can_write_its_log() {
    let mut env = setup();
    let (_agent, pda, _) = registered(&mut env);
    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    let ix = attest_ix(&env, &intruder.pubkey(), pda, [6u8; 32], 0, ACTION_HOLD);
    assert!(send(&mut env, &[ix], &[&intruder]).is_err());
    assert_eq!(read_log(&env, &pda).count, 0);
}

#[test]
fn zero_hash_and_unknown_action_are_rejected() {
    let mut env = setup();
    let (agent, pda, _) = registered(&mut env);
    let zero = attest_ix(&env, &agent.pubkey(), pda, [0u8; 32], 0, ACTION_HOLD);
    assert!(send(&mut env, &[zero], &[&agent]).unwrap_err().contains("EmptyReceipt"));
    let bad = attest_ix(&env, &agent.pubkey(), pda, [1u8; 32], 0, 9);
    assert!(send(&mut env, &[bad], &[&agent]).unwrap_err().contains("InvalidAction"));
}

#[test]
fn policy_change_is_folded_into_the_head() {
    let mut env = setup();
    let (agent, pda, policy) = registered(&mut env);
    let a = attest_ix(&env, &agent.pubkey(), pda, [1u8; 32], 0, ACTION_HOLD);
    send(&mut env, &[a], &[&agent]).unwrap();

    let new_policy = [8u8; 32];
    let ix = Instruction::new_with_bytes(
        env.program_id,
        &solana_agent_receipts::instruction::UpdatePolicy { policy_hash: new_policy }.data(),
        solana_agent_receipts::accounts::UpdatePolicy {
            authority: agent.pubkey(),
            agent_log: pda,
            event_authority: env.event_authority,
            program: env.program_id,
        }
        .to_account_metas(None),
    );
    send(&mut env, &[ix], &[&agent]).unwrap();

    let mut expected = next_policy_head(&[0u8; 32], &policy, 1);
    expected = next_receipt_head(&expected, &[1u8; 32], 0, ACTION_HOLD);
    expected = next_policy_head(&expected, &new_policy, 2);
    let log = read_log(&env, &pda);
    assert_eq!(log.policy_version, 2);
    assert_eq!(log.policy_hash, new_policy);
    assert_eq!(log.head, expected);
}
