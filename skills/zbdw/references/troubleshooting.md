# zbdw Troubleshooting

Use this playbook to map `zbdw` JSON errors to concrete fixes.

## Fast Triage

1. Confirm runtime: Node.js `>=22`
2. Confirm command path: `zbdw --help` or `npx @zbdpay/agent-wallet --help`
3. Confirm API key source with precedence (`--key` > `ZBD_API_KEY` > config)
4. Re-run failing command and inspect `error`, `message`, and `details`

## Error Mapping

### `missing_api_key`

Cause:
- no valid key in flag, env var, or config

Fix:
- pass `--key <apiKey>`, or
- set `ZBD_API_KEY`, or
- run `zbdw init --key <apiKey>` to persist config

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
- verify `ZBD_AI_BASE_URL`
- verify network access to `${ZBD_AI_BASE_URL}/api/register`

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

## Practical Diagnostics

### Check effective environment

```bash
env | grep '^ZBD_'
```

### Verify config files

```bash
ls -la ~/.zbd-wallet
```

Expected files:
- `config.json`
- `payments.json`
- `token-cache.json`

### Validate L402 cache behavior

```bash
zbdw fetch "https://api.example.com/premium" --max-sats 100
zbdw fetch "https://api.example.com/premium" --max-sats 100
```

Expected:
- first call may include non-null `payment_id`
- second call may return `payment_id: null` when token is reused
