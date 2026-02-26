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

## L402 Protected Fetch

### Fetch a paid endpoint

```bash
zbdw fetch <url> [--method <http_method>] [--data <json>] [--max-sats <amount>]
```

Expected fields:
- `status` (HTTP status)
- `headers` (response headers)
- `body` (JSON or text)
- `payment_id` (string or `null`)
- `amount_paid_sats` (number or `null`)

Token-cache behavior:
- first paid call often includes non-null `payment_id` and `amount_paid_sats`
- follow-up calls may reuse cached token and return both as `null`

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
