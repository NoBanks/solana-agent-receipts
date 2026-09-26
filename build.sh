#!/bin/sh
# SBPF v0 on purpose: devnet still deploys v0 and litesvm 0.10 only loads v0.
# Anchor 1.2 defaults to v3, which the tests cannot load.
set -e
anchor build --arch v0 "$@"
mkdir -p idl && cp target/idl/solana_agent_receipts.json idl/
