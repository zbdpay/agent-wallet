# @zbdpay/agent-wallet

`zbdw` CLI for wallet operations, registration, history, and L402-aware fetch flows.

## Requirements

- Node.js `>=22`
- npm

## Install

```bash
npm install @zbdpay/agent-wallet
```

Run without installation:

```bash
npx @zbdpay/agent-wallet init --key <apiKey>
```

Global install for frequent use:

```bash
npm install -g @zbdpay/agent-wallet
zbdw balance
```

Local repo usage from `/Users/andreneves/Code/zbd/agents`:

```bash
npm --prefix agent-wallet run build
alias zbdw='node agent-wallet/dist/cli.js'
```

## Environment Variables

- `ZBD_API_KEY`: API key used by wallet calls and payments
- `ZBD_API_BASE_URL`: ZBD API base URL, default `https://api.zbdpay.com`
- `ZBD_AI_BASE_URL`: registration service base URL, default `https://zbd.ai`
- `ZBD_WALLET_CONFIG`: config path, default `~/.zbd-wallet/config.json`
- `ZBD_WALLET_PAYMENTS`: payment history path, default `~/.zbd-wallet/payments.json`
- `ZBD_WALLET_TOKEN_CACHE`: token cache path, default `~/.zbd-wallet/token-cache.json`

## Commands

```bash
zbdw init [--key <apiKey>]
zbdw info
zbdw balance

zbdw receive <amount_sats>
zbdw receive --static

zbdw send <destination> <amount_sats>
zbdw payments
zbdw payment <id>

zbdw paylink create <amount_sats>
zbdw paylink get <id>
zbdw paylink list
zbdw paylink cancel <id>

zbdw withdraw create <amount_sats>
zbdw withdraw status <withdraw_id>

zbdw onchain quote <amount_sats> <destination>
zbdw onchain send <amount_sats> <destination> --accept-terms [--payout-id <id>]
zbdw onchain status <payout_id>
zbdw onchain retry-claim <payout_id>

zbdw fetch <url> [--method <method>] [--data <json>] [--max-sats <amount>]
```

### Destination Types (`send`)

- `lnbc...` -> Bolt11 invoice
- `lnurl...` -> LNURL
- `@name` -> ZBD gamertag
- `name@domain.com` -> Lightning address

### Paylink Commands

Paylinks are hosted payment pages at `zbd.ai/paylinks/<id>`. Share the `url` with a payer; the link handles the invoice lifecycle.

```bash
# Create a paylink for 250 sats
zbdw paylink create 250
# {"id":"pl_001","url":"https://zbd.ai/paylinks/pl_001","status":"active","lifecycle":"active","amount_sats":250}

# Fetch current state (also syncs settlement to local payments.json)
zbdw paylink get pl_001
# {"id":"pl_001","url":"...","status":"active","lifecycle":"active","amount_sats":250,"created_at":"...","updated_at":"..."}

# List all paylinks
zbdw paylink list
# {"paylinks":[...]}

# Cancel a paylink (transitions lifecycle to dead)
zbdw paylink cancel pl_001
# {"id":"pl_001","url":"...","status":"dead","lifecycle":"dead"}
```

**Lifecycle values:** `created` -> `active` -> `paid | expired | dead`

Terminal states (`paid`, `expired`, `dead`) are permanent. A paid link cannot be reused; an expired or cancelled link cannot be reactivated.

`paylink get` also polls the latest payment attempt and appends a settlement record to `~/.zbd-wallet/payments.json` with `paylink_id`, `paylink_lifecycle`, and `paylink_amount_sats` metadata.
## Onchain Payout Commands

Onchain payouts send bitcoin to a native BTC address via the `zbd-ai` payout service.

```bash
# Get a fee quote before sending
zbdw onchain quote 10000 bc1qexample...
# {"quote_id":"q_001","amount_sats":10000,"fee_sats":150,"total_sats":10150,"destination":"bc1q...","expires_at":"..."}

# Send onchain (--accept-terms is required)
zbdw onchain send 10000 bc1qexample... --accept-terms
# {"payout_id":"payout_123","status":"queued","amount_sats":10000,"destination":"bc1q...","request_id":"req_abc","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_001"}}

# Check payout status
zbdw onchain status payout_123
# {"payout_id":"payout_123","status":"broadcasting","amount_sats":10000,"destination":"bc1q...","txid":null,"failure_code":null,"kickoff":{...}}

# Retry claim after a failed_invoice_expired payout
zbdw onchain retry-claim payout_123
# {"payout_id":"payout_123","status":"queued","kickoff":{"enqueued":true,"workflow":"payout.workflow.root","kickoff_id":"k_002"}}
```

**`--accept-terms` is required for `onchain send`.** Omitting it exits immediately with `accept_terms_required` and makes no outbound request.

**Payout status values:** `created` -> `queued` -> `broadcasting` -> `succeeded` (terminal) or `failed_invoice_expired` | `failed_lockup` | `refunded` | `manual_review` (terminal)

Successful `onchain send` appends a record to `~/.zbd-wallet/payments.json` with `source: "onchain"`, `onchain_network`, `onchain_address`, and `onchain_payout_id` metadata.

## JSON Output Contract

CLI writes JSON to stdout for both success and failure.

Failure shape:

```json
{
  "error": "error_code",
  "message": "Human-readable message",
  "details": {}
}
```

Examples:

- `init`: `{ "lightningAddress": "name@zbd.ai", "status": "ok" }`
- `info`: `{ "lightningAddress": "...", "apiKey": "***", "balance_sats": 123 }`
- `fetch`: `{ "status": 200, "body": {...}, "payment_id": "...|null", "amount_paid_sats": 21|null }`
- `paylink create`: `{ "id": "pl_001", "url": "https://zbd.ai/paylinks/pl_001", "status": "active", "lifecycle": "active", "amount_sats": 250 }`
- `paylink get`: adds `created_at` and `updated_at` to the above
- `paylink list`: `{ "paylinks": [...] }` where each item matches `paylink get` shape
- `paylink cancel`: `{ "id": "...", "url": "...", "status": "dead", "lifecycle": "dead" }`
- `onchain quote`: `{ "quote_id": "...", "amount_sats": N, "fee_sats": N, "total_sats": N, "destination": "...", "expires_at": "..." }`
- `onchain send`: `{ "payout_id": "...", "status": "queued", "amount_sats": N, "destination": "...", "request_id": "...", "kickoff": {...} }`
- `onchain status`: `{ "payout_id": "...", "status": "...", "amount_sats": N|null, "destination": "...", "txid": "...|null", "failure_code": "...|null", "kickoff": {...} }`
- `onchain retry-claim`: `{ "payout_id": "...", "status": "queued", "kickoff": {...} }`
## Storage Files

- Config: `~/.zbd-wallet/config.json`
  - `apiKey`
  - `lightningAddress`
- Payment history: `~/.zbd-wallet/payments.json`
  - paylink settlement records include `paylink_id`, `paylink_lifecycle`, `paylink_amount_sats`
  - onchain payout records include `source: "onchain"`, `onchain_network`, `onchain_address`, `onchain_payout_id`
- Token cache: `~/.zbd-wallet/token-cache.json`
## L402 Fetch Flow

`zbdw fetch` is powered by `@zbdpay/agent-fetch`.

- parses `402` challenge
- pays invoice via wallet API
- retries with proof
- caches token
- enforces optional `--max-sats`

Call twice against the same protected URL to verify cache reuse:

```bash
zbdw fetch "https://your-protected-endpoint" --max-sats 100
zbdw fetch "https://your-protected-endpoint" --max-sats 100
```

On the second call, `payment_id` should be `null` when cached token is reused.

## Companion Examples You Can Run Now

`agent-wallet` does not ship its own `examples/` folder yet, but the fastest end-to-end examples are in companion repos:

- `../agent-pay/examples/http-server.mjs` (serve a paid endpoint)
- `../agent-fetch/examples/zbd-agent-fetch.mjs` (pay and fetch that endpoint)

From `/Users/andreneves/Code/zbd/agents`:

```bash
npm --prefix agent-pay run build
ZBD_API_KEY=<your_api_key> npm --prefix agent-pay run example:http-server
```

Then in another terminal:

```bash
npm --prefix agent-wallet run build
node agent-wallet/dist/cli.js fetch "http://localhost:8787/protected" --max-sats 100
```

## Scripts

```bash
npm run build
npm run test
npm run lint
npm run typecheck
npm run release:dry-run
```

## Troubleshooting

- `zsh: command not found: zbdw`
  - build first and add alias, or install package globally
- `register_failed` during `init`
  - ensure `ZBD_AI_BASE_URL` points to your running `zbd-ai` instance
  - confirm upstream `ZBD_API_BASE_URL` and API key are valid for static charge creation
- `wallet_response_invalid` during `info`/`balance`
  - verify wallet endpoint returns a valid balance shape and that `ZBD_API_BASE_URL` is correct
- `accept_terms_required` during `onchain send`
  - add `--accept-terms` flag to confirm consent; the flag is required and there is no interactive prompt
- `onchain_payout_request_failed` during `onchain send/status/retry-claim`
  - verify `ZBD_AI_BASE_URL` points to your running `zbd-ai` instance
  - inspect `details.status` and `details.response` for upstream error context
- `failed_invoice_expired` payout status
  - the payout's internal invoice expired before the claim completed; run `zbdw onchain retry-claim <payout_id>` to re-enqueue
