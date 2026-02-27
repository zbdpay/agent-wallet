---
name: zbdw
description: >-
  Operate ZBD agent wallets with the zbdw CLI: setup, balance checks, send/receive,
  withdrawals, onchain payouts, and L402 paid fetch. Use when users ask to configure zbdw, run wallet
  commands, pay Lightning invoices or addresses, inspect payment history, fetch
  paywalled endpoints, or send bitcoin to onchain addresses. Triggers on "zbdw", "agent wallet",
  "send sats", "Lightning address", "withdraw", "payment id", "L402", "paywall",
  "fetch paid endpoint", "ZBD API key", "paylink", "create paylink", "hosted payment link",
  "paylink cancel", "paylink status", "onchain", "onchain payout", "bitcoin address",
  "accept terms", "retry claim", "payout status".
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
- User needs to create, inspect, list, or cancel a hosted paylink
- User needs to send bitcoin to an onchain address via `zbdw onchain send`
- User needs to quote, check status, or retry an onchain payout
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
| Create hosted paylink | `zbdw paylink create <amount_sats>` |
| Get paylink details | `zbdw paylink get <id>` |
| List all paylinks | `zbdw paylink list` |
| Cancel a paylink | `zbdw paylink cancel <id>` |
| Quote onchain payout | `zbdw onchain quote <amount_sats> <destination>` |
| Send onchain payout | `zbdw onchain send <amount_sats> <destination> --accept-terms` |
| Check onchain payout status | `zbdw onchain status <payout_id>` |
| Retry failed onchain claim | `zbdw onchain retry-claim <payout_id>` |

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

Paylink success examples:

```json
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250}
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250,"created_at":"2026-02-26T00:00:00.000Z","updated_at":"2026-02-26T00:10:00.000Z"}
{"paylinks":[{"id":"pl_001","url":"...","status":"active","lifecycle":"active","amount_sats":250,"created_at":"...","updated_at":"..."}]}
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"dead","lifecycle":"dead"}
```

Paylink lifecycle values (fixed vocabulary): `created` | `active` | `paid` | `expired` | `dead`

```json
{"quote_id":"q_001","amount_sats":10000,"fee_sats":150,"total_sats":10150,"destination":"bc1q...","expires_at":"2026-02-27T00:05:00.000Z"}
{"payout_id":"payout_123","status":"queued","amount_sats":10000,"destination":"bc1q...","request_id":"req_abc","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_001"}}
{"payout_id":"payout_123","status":"broadcasting","amount_sats":10000,"destination":"bc1q...","txid":null,"failure_code":null,"kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_001"}}
{"payout_id":"payout_123","status":"queued","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_002"}}
```

Onchain payout lifecycle values (fixed vocabulary): `created` | `queued` | `broadcasting` | `succeeded` | `failed_invoice_expired` | `failed_lockup` | `refunded` | `manual_review`

Terminal onchain statuses: `succeeded`, `failed_invoice_expired`, `failed_lockup`, `refunded`, `manual_review`. Only `failed_invoice_expired` supports `retry-claim`.

Error shape:

```json
{"error":"error_code","message":"Human-readable message","details":{}}
```

Paylink API error shape (includes upstream context):

```json
{"error":"invalid_paylink_amount","message":"Amount must be a positive integer in sats","details":{"status":400,"path":"/api/paylinks","response":{"error":"invalid_paylink_amount"}}}
```

## Red Flags - STOP

- Missing API key source -> do not continue with payment actions
- Amount is non-integer or <= 0 for send/receive/withdraw/paylink create/onchain -> reject and correct input
- `fetch --max-sats` would be exceeded -> stop instead of forcing payment
- Destination format unclear -> stop and normalize destination first
- Paylink `lifecycle` is `paid`, `expired`, or `dead` -> do not attempt to reuse or cancel; it is terminal
- `onchain send` called without `--accept-terms` -> stop; the flag is required and there is no interactive prompt
- Onchain payout status is a terminal state other than `failed_invoice_expired` -> do not call `retry-claim`

## Common Mistakes

| Mistake | Fix |
|---|---|
| Using wrong key header assumptions | zbdw already uses `apikey` header internally; provide valid API key only |
| Expecting human-readable plain text output | Parse JSON output for automation workflows |
| Treating `payment <id>` as remote-only lookup | It is local-first and falls back to API when needed |
| Forgetting Node version constraints | Use Node.js 22+ |
| Setting empty `ZBD_API_BASE_URL` and expecting default | Unset the variable entirely or set a valid URL |
| Confusing `status` and `lifecycle` on paylinks | `status` is the raw API field; `lifecycle` is the canonical state machine value (`created\|active\|paid\|expired\|dead`) |
| Expecting `paylink cancel` to return timestamps | Cancel output is `{id, url, status, lifecycle}` only; no `created_at`/`updated_at` |
| Calling `onchain send` without `--accept-terms` | The flag is required; omitting it returns `accept_terms_required` before any network call |
| Calling `retry-claim` on a non-`failed_invoice_expired` payout | Only `failed_invoice_expired` supports retry; other terminal statuses are permanent |
| Expecting `onchain send` to complete synchronously | Payout status starts as `queued`; poll `onchain status` for settlement |

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
