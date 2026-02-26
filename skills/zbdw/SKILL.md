---
name: zbdw
description: >-
  Operate ZBD agent wallets with the zbdw CLI: setup, balance checks, send/receive,
  withdrawals, and L402 paid fetch. Use when users ask to configure zbdw, run wallet
  commands, pay Lightning invoices or addresses, inspect payment history, or fetch
  paywalled endpoints. Triggers on "zbdw", "agent wallet", "send sats", "Lightning address",
  "withdraw", "payment id", "L402", "paywall", "fetch paid endpoint", "ZBD API key".
argument-hint: <zbdw task or command>
homepage: https://github.com/zbdpay/agent-wallet
metadata:
  openclaw:
    emoji: "⚡"
    requires:
      anyBins:
        - zbdw
        - npx
    install:
      - id: node-global
        kind: node
        package: "@zbdpay/agent-wallet"
        bins:
          - zbdw
        label: Install zbdw globally (npm)
---

# zbdw Wallet Operations

Use this skill to run safe, repeatable `zbdw` wallet workflows and return machine-readable JSON results.

## When to Use

- User needs to install or initialize ZBD wallet CLI
- User asks to check balance, send, receive, withdraw, or inspect payment history
- User needs to fetch an L402-protected endpoint with payment caps
- User needs troubleshooting for common `zbdw` error codes

## Core Workflow

1. Confirm CLI availability (`zbdw --help` or `npx @zbdpay/agent-wallet --help`).
2. Resolve API key source with strict precedence:
   - `--key` flag
   - `ZBD_API_KEY` env var
   - `~/.zbd-wallet/config.json`
3. Run the minimum command needed for the task.
4. Return structured output and explain key fields.
5. If command fails, map error code to concrete next action.

## Setup and First Run

```bash
# global install
npm install -g @zbdpay/agent-wallet

# or one-shot
npx @zbdpay/agent-wallet init --key <your_api_key>

# validate setup
zbdw info
zbdw balance
```

## Command Quick Reference

| Task | Command |
|---|---|
| Initialize wallet identity | `zbdw init --key <apiKey>` |
| Show wallet metadata | `zbdw info` |
| Get wallet balance | `zbdw balance` |
| Create invoice | `zbdw receive <amount_sats>` |
| Create static receive endpoint | `zbdw receive --static [amount_sats]` |
| Send payment | `zbdw send <destination> <amount_sats>` |
| List local payments | `zbdw payments` |
| Inspect one payment | `zbdw payment <id>` |
| Create withdraw request | `zbdw withdraw create <amount_sats>` |
| Check withdraw status | `zbdw withdraw status <withdraw_id>` |
| Fetch paid endpoint | `zbdw fetch <url> [--method] [--data] [--max-sats]` |

## Destination Rules for `zbdw send`

- `lnbc...` -> BOLT11 invoice
- `lnurl...` -> LNURL pay
- `@gamertag` -> ZBD gamertag payout
- `name@domain.com` -> Lightning Address payout

If destination does not match one of these forms, return `unsupported_destination` and ask for a valid target.

## L402 Paid Fetch Pattern

```bash
# first request may pay and cache token
zbdw fetch "https://api.example.com/premium" --max-sats 100

# second request should reuse cache when token is still valid
zbdw fetch "https://api.example.com/premium" --max-sats 100
```

Interpretation:
- first call often includes non-null `payment_id` / `amount_paid_sats`
- cache hits often return `payment_id: null` and `amount_paid_sats: null`

## JSON Contract

Always expect JSON output.

Success examples:

```json
{"lightningAddress":"name@zbd.ai","status":"ok"}
{"balance_sats":50000}
{"payment_id":"pay_123","fee_sats":1,"status":"completed"}
```

Error shape:

```json
{"error":"error_code","message":"Human-readable message","details":{}}
```

## Red Flags - STOP

- Missing API key source -> do not continue with payment actions
- Amount is non-integer or <= 0 for send/receive/withdraw -> reject and correct input
- `fetch --max-sats` would be exceeded -> stop instead of forcing payment
- Destination format unclear -> stop and normalize destination first

## Common Mistakes

| Mistake | Fix |
|---|---|
| Using wrong key header assumptions | zbdw already uses `apikey` header internally; provide valid API key only |
| Expecting human-readable plain text output | Parse JSON output for automation workflows |
| Treating `payment <id>` as remote-only lookup | It is local-first and falls back to API when needed |
| Forgetting Node version constraints | Use Node.js 22+ |
| Setting empty `ZBD_API_BASE_URL` and expecting default | Unset the variable entirely or set a valid URL |

## Useful Environment Variables

| Variable | Default |
|---|---|
| `ZBD_API_KEY` | none |
| `ZBD_API_BASE_URL` | `https://api.zbdpay.com` |
| `ZBD_AI_BASE_URL` | `https://zbd.ai` |
| `ZBD_WALLET_CONFIG` | `~/.zbd-wallet/config.json` |
| `ZBD_WALLET_PAYMENTS` | `~/.zbd-wallet/payments.json` |
| `ZBD_WALLET_TOKEN_CACHE` | `~/.zbd-wallet/token-cache.json` |
| `ZBDW_NO_PROGRESS` | unset |

## Additional Resources

- [`references/command-reference.md`](references/command-reference.md) for command outputs and task mapping
- [`references/troubleshooting.md`](references/troubleshooting.md) for error-code playbook

Use these references when a task needs exact output fields or concrete recovery steps.
