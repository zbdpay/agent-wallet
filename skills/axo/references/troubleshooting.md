# axo Troubleshooting

Use this playbook to map `axo` JSON errors to concrete fixes.

## Fast Triage

1. Confirm runtime: Node.js `>=22`
2. Confirm command path: `axo --help` or `npx @axobot/cli --help`
3. Confirm API key source with precedence (`--key` > `ZBD_API_KEY` > config)
4. Re-run failing command and inspect `error`, `message`, and `details`

## Error Mapping

### `missing_api_key`

Cause:
- no valid key in flag, env var, or config

Fix:
- pass `--key <apiKey>`, or
- set `ZBD_API_KEY`, or
- run `axo init --key <apiKey>` to persist config

### `invalid_api_key`

Cause:
- ZBD API rejected provided key

Fix:
- verify key value and environment
- ensure `ZBD_API_BASE_URL` points to the correct ZBD API host

### `register_unreachable`

Cause:
- registration service cannot be reached

Fix:
- verify `AXO_BASE_URL`
- verify network access to `${AXO_BASE_URL}/api/register`

### `register_failed`

Cause:
- registration endpoint returned non-success or invalid payload

Fix:
- inspect `details.status` and `details.response`
- validate upstream static charge/create identity dependencies

### `wallet_request_failed`

Cause:
- wallet endpoint request failed

Fix:
- verify `ZBD_API_BASE_URL`
- check API availability and auth scope

### `wallet_response_invalid`

Cause:
- wallet response missing `balance` in msats-compatible shape

Fix:
- inspect upstream response schema
- verify proxy/transformation layers are not stripping fields

### `receive_failed`

Cause:
- invoice/static charge response missing required fields

Fix:
- check upstream API response payload
- confirm request params and API compatibility

### `unsupported_destination`

Cause:
- `send` destination does not match supported patterns

Fix:
- normalize destination to one of:
  - `lnbc...`
  - `lnurl...`
  - `@gamertag`
  - `name@domain.com`

### `invalid_amount`

Cause:
- amount not a positive integer sats value

Fix:
- provide integer sats (`1`, `1000`, `50000`)

### `fetch_budget_exceeded`

Cause:
- invoice cost exceeds `--max-sats`

Fix:
- increase `--max-sats` intentionally, or
- do not pay and choose another endpoint

## Paylink Errors

Paylink commands call `AXO_BASE_URL` (default `https://axo.bot`). Errors from the paylink API are passed through as-is with upstream context in `details`.

Error envelope shape:

```json
{"error":"error_code","message":"Human-readable message","details":{"status":400,"path":"/api/paylinks","response":{}}}
```

### `invalid_paylink_amount`

Cause:
- `amount_sats` is not a positive integer

Fix:
- provide a positive integer sats value (`1`, `250`, `1000`)
- check that `parseAmountSats` validation passes before the API call

### `paylink_not_found`

Cause:
- paylink `id` does not exist in the upstream service

Fix:
- verify the paylink `id` from a prior `paylink create` or `paylink list` call
- check `AXO_BASE_URL` points to the correct service

### `paylink_already_terminal`

Cause:
- attempted to cancel or modify a paylink whose `lifecycle` is `paid`, `expired`, or `dead`

Fix:
- do not cancel terminal paylinks; the operation is a no-op at best
- check `lifecycle` with `paylink get` before attempting cancel

### `paylink_request_failed`

Cause:
- network or upstream service error when calling the paylink API

Fix:
- verify `AXO_BASE_URL` is reachable
- inspect `details.status` and `details.response` for upstream error context
- retry if the error is transient (5xx)

## Paylink Settlement Errors

`paylink get` fetches the latest settlement attempt charge via the ZBD API (`ZBD_API_BASE_URL`). Errors during settlement projection do not block the paylink output but may leave local `payments.json` incomplete.

### Settlement projection missing from `payments.json`

Cause:
- paylink has no `paid_payment_id`, `latest_attempt_id`, or `active_attempt_id` (no attempt yet)
- charge fetch from `/v0/charges/:id` failed

Fix:
- run `paylink get` again after a payment attempt is made
- verify `ZBD_API_BASE_URL` is reachable and the API key has charge read access

### Duplicate settlement records not appearing

Cause:
- `appendPaymentIfMissingById` is idempotent; repeated `paylink get` calls for the same charge will not create duplicates

Fix:
- this is expected behavior; check `payments.json` for the single canonical record

## Practical Diagnostics

### Check effective environment

```bash
env | grep '^ZBD_'
env | grep '^AXO_'
```

### Verify config files

```bash
ls -la ~/.axo-wallet
```

Expected files:
- `config.json`
- `payments.json`
- `token-cache.json`

### Validate L402 cache behavior

```bash
axo fetch "https://api.example.com/premium" --max-sats 100
axo fetch "https://api.example.com/premium" --max-sats 100
```

Expected:
- first call may include non-null `payment_id`
- second call may return `payment_id: null` when token is reused

### Validate paylink lifecycle

```bash
# create a paylink
axo paylink create 250

# inspect current state
axo paylink get <id>

# list all paylinks
axo paylink list

# cancel if still active
axo paylink cancel <id>
```

Expected lifecycle progression: `created` -> `active` -> `paid` (terminal) or `expired`/`dead` (terminal).

If `lifecycle` is already `paid`, `expired`, or `dead`, cancel will fail or be a no-op. Do not retry.

### Inspect paylink settlement in local payments

```bash
axo payments | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d).filter(p=>p.source==='paylink').forEach(p=>console.log(JSON.stringify(p)))"
```

Expected paylink payment record fields:
- `id` (charge id)
- `type` (`"receive"`)
- `amount_sats` (number)
- `status` (`"pending"` | `"completed"` | `"failed"`)
- `timestamp` (ISO timestamp)
- `source` (`"paylink"`)
- `paylink_id` (string)
- `paylink_attempt_id` (string)
- `paylink_lifecycle` (`"created"` | `"active"` | `"paid"` | `"expired"` | `"dead"`)
- `paylink_amount_sats` (number)
- `preimage` (string, present when `status` is `"completed"`)

## Onchain Payout Errors

Onchain payout commands call `AXO_BASE_URL` (default `https://axo.bot`). Errors from the payout API are passed through with upstream context in `details`.

Error envelope shape:

```json
{"error":"error_code","message":"Human-readable message","details":{"status":400,"path":"/api/payouts","response":{}}}
```

### `accept_terms_required`

Cause:
- `axo onchain send` was called without the `--accept-terms` flag

Fix:
- add `--accept-terms` to the command; this is a local preflight check and no network call is made when it fails
- there is no interactive prompt; the flag must be explicit

### `invalid_consent` (API-side, HTTP 400)

Cause:
- the `accept_terms: true` field was missing or false in the API request body

Fix:
- this should not occur when using the CLI correctly; `--accept-terms` maps directly to `accept_terms: true` in the request
- if calling the API directly, ensure `accept_terms: true` is present in the request body

### `onchain_payout_response_invalid`

Cause:
- payout API response missing required fields (`quote_id`, `payout_id`, `status`, `amount_sats`, or `destination`)

Fix:
- inspect `details.response` for the raw upstream payload
- verify `AXO_BASE_URL` points to the correct service version

### `onchain_payout_request_failed`

Cause:
- non-401 error from the payout API

Fix:
- inspect `details.status` and `details.response` for upstream error context
- verify `AXO_BASE_URL` is reachable and the API key has payout access
- retry if the error is transient (5xx)

### `onchain_payout_unreachable`

Cause:
- network failure reaching `AXO_BASE_URL`

Fix:
- verify `AXO_BASE_URL` is reachable
- check network connectivity and DNS resolution

## Onchain Payout Status Errors

### Payout stuck in `failed_invoice_expired`

Cause:
- the payout's internal invoice expired before the claim workflow completed

Fix:
- run `axo onchain retry-claim <payout_id>` to re-enqueue the claim workflow
- `retry-claim` is only valid for `failed_invoice_expired`; other terminal statuses cannot be retried

### Payout in terminal status other than `succeeded`

Cause:
- payout reached `failed_lockup`, `refunded`, or `manual_review`

Fix:
- `failed_lockup`: lockup or claim path failure; contact support with the `payout_id`
- `refunded`: funds were returned to source; create a new payout if needed
- `manual_review`: payout requires manual intervention; contact support with the `payout_id`
- do NOT call `retry-claim` for these statuses

### Validate onchain payout flow

```bash
# get a fee quote first
axo onchain quote 10000 bc1qexample...

# send with explicit consent
axo onchain send 10000 bc1qexample... --accept-terms

# poll status
axo onchain status <payout_id>

# retry if failed_invoice_expired
axo onchain retry-claim <payout_id>
```

Expected status progression: `queued` -> `broadcasting` -> `succeeded` (terminal) or `failed_invoice_expired` (retryable terminal).

### Inspect onchain records in local payments

```bash
axo payments | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d).filter(p=>p.source==='onchain').forEach(p=>console.log(JSON.stringify(p)))"
```

Expected onchain payment record fields:
- `id` (payout id)
- `type` (`"send"`)
- `amount_sats` (number)
- `status` (string)
- `timestamp` (ISO timestamp)
- `source` (`"onchain"`)
- `onchain_network` (`"bitcoin"`)
- `onchain_address` (string)
- `onchain_payout_id` (string)
