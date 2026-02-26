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

zbdw withdraw create <amount_sats>
zbdw withdraw status <withdraw_id>

zbdw fetch <url> [--method <method>] [--data <json>] [--max-sats <amount>]
```

### Destination Types (`send`)

- `lnbc...` -> Bolt11 invoice
- `lnurl...` -> LNURL
- `@name` -> ZBD gamertag
- `name@domain.com` -> Lightning address

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

## Storage Files

- Config: `~/.zbd-wallet/config.json`
  - `apiKey`
  - `lightningAddress`
- Payment history: `~/.zbd-wallet/payments.json`
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
