# zbdw Command Reference

This reference maps common user intents to exact `zbdw` commands and expected JSON fields.

## Setup and Identity

### Initialize wallet config

```bash
zbdw init --key <apiKey>
```

Expected fields:
- `lightningAddress` (string)
- `status` (`"ok"`)

### Inspect configured wallet

```bash
zbdw info
```

Expected fields:
- `lightningAddress` (string or `null`)
- `apiKey` (`"***"`)
- `balance_sats` (number)

## Balance and Receiving

### Check balance

```bash
zbdw balance
```

Expected fields:
- `balance_sats` (number)

### Create one-time invoice

```bash
zbdw receive <amount_sats> [description]
```

Expected fields:
- `invoice` (BOLT11)
- `payment_hash` (string or `null`)
- `expires_at` (ISO timestamp)

### Create static receive endpoint

```bash
zbdw receive --static [amount_sats] [description]
```

Expected fields:
- `charge_id` (string)
- `lightning_address` (string, optional)
- `lnurl` (string, optional)

## Sending and Payment History

### Send sats to destination

```bash
zbdw send <destination> <amount_sats>
```

Destination patterns:
- `lnbc...` -> BOLT11
- `lnurl...` -> LNURL
- `@name` -> ZBD gamertag
- `name@domain.com` -> Lightning Address

Expected fields:
- `payment_id` (string)
- `fee_sats` (number)
- `status` (string)
- `preimage` (string, optional)

### List local payments

```bash
zbdw payments
```

Expected output: JSON array of payment records.

### Inspect one payment

```bash
zbdw payment <id>
```

Behavior:
- returns local record if present
- falls back to API lookup when missing locally

## Withdraw

### Create withdraw request

```bash
zbdw withdraw create <amount_sats>
```

Expected fields:
- `withdraw_id` (string)
- `lnurl` (string)

### Check withdraw status

```bash
zbdw withdraw status <withdraw_id>
```

Expected fields:
- `withdraw_id` (string)
- `status` (string)
- `amount_sats` (number)

## Paylinks

Paylinks are hosted payment pages managed via the `zbd-ai` service. All paylink commands use `ZBD_AI_BASE_URL` (default `https://zbd.ai`) for API calls.

Lifecycle vocabulary (fixed): `created` | `active` | `paid` | `expired` | `dead`

Terminal states: `paid`, `expired`, `dead`. Do not attempt to cancel or reuse a paylink in a terminal state.

### Create a paylink

```bash
zbdw paylink create <amount_sats>
```

Expected fields:
- `id` (string)
- `url` (string, hosted payment page URL)
- `status` (string)
- `lifecycle` (`"created"` | `"active"` | `"paid"` | `"expired"` | `"dead"`)
- `amount_sats` (number)

Example output:

```json
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250}
```

### Get paylink details

```bash
zbdw paylink get <id>
```

Expected fields:
- `id` (string)
- `url` (string)
- `status` (string)
- `lifecycle` (`"created"` | `"active"` | `"paid"` | `"expired"` | `"dead"`)
- `amount_sats` (number)
- `created_at` (ISO timestamp)
- `updated_at` (ISO timestamp)

Side effect: if the paylink has a pending or completed settlement attempt, `paylink get` fetches the charge detail and appends it to local `payments.json` with paylink metadata (`source`, `paylink_id`, `paylink_attempt_id`, `paylink_lifecycle`, `paylink_amount_sats`). This append is idempotent.

Example output:

```json
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250,"created_at":"2026-02-26T00:00:00.000Z","updated_at":"2026-02-26T00:10:00.000Z"}
```

### List paylinks

```bash
zbdw paylink list
```

Expected fields:
- `paylinks` (array of paylink records)

Each record in `paylinks`:
- `id` (string)
- `url` (string)
- `status` (string)
- `lifecycle` (`"created"` | `"active"` | `"paid"` | `"expired"` | `"dead"`)
- `amount_sats` (number)
- `created_at` (ISO timestamp)
- `updated_at` (ISO timestamp)

Example output:

```json
{
  "paylinks": [
    {"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250,"created_at":"2026-02-26T00:00:00.000Z","updated_at":"2026-02-26T00:10:00.000Z"},
    {"id":"pl_002","url":"https://zbd.ai/paylinks/pl_002","status":"dead","lifecycle":"dead","amount_sats":500,"created_at":"2026-02-26T00:20:00.000Z","updated_at":"2026-02-26T00:25:00.000Z"}
  ]
}
```

### Cancel a paylink

```bash
zbdw paylink cancel <id>
```

Expected fields:
- `id` (string)
- `url` (string)
- `status` (string)
- `lifecycle` (`"created"` | `"active"` | `"paid"` | `"expired"` | `"dead"`)

Note: cancel output does NOT include `created_at` or `updated_at`.

Example output:

```json
{"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"dead","lifecycle":"dead"}
```

### Paylink error envelope

Paylink API errors include upstream context in `details`:

```json
{"error":"invalid_paylink_amount","message":"Amount must be a positive integer in sats","details":{"status":400,"path":"/api/paylinks","response":{"error":"invalid_paylink_amount"}}}
```

Fields in `details`:
- `status` (number, HTTP status from upstream)
- `path` (string, API path that failed)
- `response` (object, raw upstream response body)

## L402 Protected Fetch

### Fetch a paid endpoint

```bash
zbdw fetch <url> [--method <http_method>] [--data <json>] [--max-sats <amount>]
```

Expected fields:
- `status` (HTTP status)
- `body` (JSON or text)
- `payment_id` (string or `null`)
- `amount_paid_sats` (number or `null`)

Token-cache behavior:
- first paid call often includes non-null `payment_id` and `amount_paid_sats`
- follow-up calls may reuse cached token and return both as `null`

## Onchain Payouts

Onchain payout commands call `ZBD_AI_BASE_URL` (default `https://zbd.ai`). All commands use both `apikey` and `x-api-key` headers.

Payout status vocabulary (fixed): `created` | `queued` | `broadcasting` | `succeeded` | `failed_invoice_expired` | `failed_lockup` | `refunded` | `manual_review`

Terminal statuses: `succeeded`, `failed_invoice_expired`, `failed_lockup`, `refunded`, `manual_review`.

### Quote an onchain payout

```bash
zbdw onchain quote <amount_sats> <destination>
```

Expected fields:
- `quote_id` (string)
- `amount_sats` (number)
- `fee_sats` (number)
- `total_sats` (number)
- `destination` (string)
- `expires_at` (ISO timestamp)

Example output:

```json
{"quote_id":"q_001","amount_sats":10000,"fee_sats":150,"total_sats":10150,"destination":"bc1qexample...","expires_at":"2026-02-27T00:05:00.000Z"}
```

### Send an onchain payout

```bash
zbdw onchain send <amount_sats> <destination> --accept-terms [--payout-id <id>]
```

**`--accept-terms` is required.** Omitting it exits immediately with `accept_terms_required` before any network call.

Expected fields:
- `payout_id` (string)
- `status` (string, typically `"queued"` on creation)
- `amount_sats` (number)
- `destination` (string)
- `request_id` (string or `null`)
- `kickoff` (object: `enqueued`, `workflow`, `kickoff_id`)

Example output:

```json
{"payout_id":"payout_123","status":"queued","amount_sats":10000,"destination":"bc1qexample...","request_id":"req_abc123","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_001"}}
```

Side effect: appends a record to `~/.zbd-wallet/payments.json` with `source: "onchain"`, `onchain_network: "bitcoin"`, `onchain_address`, and `onchain_payout_id`.

### Get onchain payout status

```bash
zbdw onchain status <payout_id>
```

Expected fields:
- `payout_id` (string)
- `status` (string)
- `amount_sats` (number or `null`)
- `destination` (string or `null`)
- `txid` (string or `null`)
- `failure_code` (string or `null`)
- `kickoff` (object: `enqueued`, `workflow`, `kickoff_id`)

Example output:

```json
{"payout_id":"payout_123","status":"broadcasting","amount_sats":10000,"destination":"bc1qexample...","txid":null,"failure_code":null,"kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_001"}}
```

### Retry claim for a failed payout

```bash
zbdw onchain retry-claim <payout_id>
```

Only meaningful when payout status is `failed_invoice_expired`. Re-enqueues the claim workflow.

Expected fields:
- `payout_id` (string)
- `status` (string, typically `"queued"` after retry)
- `kickoff` (object: `enqueued`, `workflow`, `kickoff_id`)

Example output:

```json
{"payout_id":"payout_123","status":"queued","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_002"}}
```

### Onchain payout error envelope

Onchain API errors include upstream context in `details`:

```json
{"error":"onchain_payout_request_failed","message":"Onchain payout API request failed","details":{"status":400,"path":"/api/payouts","response":{"error":"invalid_consent"}}}
```

Fields in `details`:
- `status` (number, HTTP status from upstream)
- `path` (string, API path that failed)
- `response` (object, raw upstream response body)

## Output Contract

All commands return JSON to stdout.

Error envelope:

```json
{"error":"error_code","message":"Human-readable message","details":{}}
```

## API Key Resolution Order

Resolution precedence is strict:
1. `--key`
2. `ZBD_API_KEY`
3. `~/.zbd-wallet/config.json`

If no key is available, command should fail with `missing_api_key`.
