# Engineering Contract — `@zbdpay/agent-wallet` (`zbdw`)

> **Status**: Normative. All implementation work in this repository must conform to every rule in this document.
> **Scope**: CLI wallet for AI agents. Wraps ZBD API calls, manages local config and payment history, and delegates L402 fetch flows to `@zbdpay/agent-fetch`.

---

## 1. Auth Header

### 1.1 ZBD API Authentication

All outbound calls to `api.zbdpay.com` MUST include the API key in the `apikey` HTTP header (lowercase). No other header name is accepted by the ZBD API.

```
apikey: <api-key-from-config-or-env>
```

The API key is sourced in priority order:

1. `ZBD_API_KEY` environment variable
2. `apiKey` field in `~/.zbd-wallet/config.json` (or path from `ZBD_WALLET_CONFIG`)

The CLI MUST NOT print the raw API key value in any output. The `info` command MUST mask it as `***`.

```json
{ "lightningAddress": "agent-xyz@zbd.ai", "apiKey": "***", "balance_sats": 50000 }
```

### 1.2 zbd.ai Registration Call

The `init` command calls `POST https://zbd.ai/api/register` with the API key in the request body. This is the only endpoint that receives the raw key outside of `api.zbdpay.com`. The CLI MUST NOT persist the raw key anywhere other than the local config file.

### 1.3 L402 Authorization (delegated)

The `fetch` subcommand delegates all L402 challenge/proof handling to `@zbdpay/agent-fetch`. The CLI MUST NOT reimplement L402 protocol logic. Auth header construction for L402 flows is entirely the responsibility of the `agent-fetch` library.

---

## 2. Amount Units

### 2.1 Internal Representation

All monetary amounts are stored and processed internally in **millisatoshis (msat)**. The ZBD API returns msat values on balance and payment endpoints.

```
1 sat = 1000 msat
```

### 2.2 Boundary Outputs

All CLI output — JSON fields, error messages, and verbose text — MUST express amounts in **satoshis (sat)**, not msat.

```json
{ "balance_sats": 50000 }
{ "amount_sats": 500, "fee_sats": 1 }
{ "amount_paid_sats": 10 }
```

Field names MUST use the `_sats` suffix. The `_msat` suffix MUST NOT appear in any CLI output field.

### 2.3 Conversion Rule

When the ZBD API returns an msat value, the CLI MUST divide by 1000 before including it in output. Fractional satoshis MUST be rounded down (floor).

```typescript
const balanceSats = Math.floor(balanceMsat / 1000)
```

### 2.4 Payment History File

The local payments log at `~/.zbd-wallet/payments.json` stores amounts in satoshis. msat values MUST be converted before writing to this file. The file schema is:

```json
[{ "id": "pay_xyz", "type": "send", "amount_sats": 500, "status": "completed", "timestamp": "..." }]
```

---

## 3. Release Policy

### 3.1 Versioning

This package follows **Semantic Versioning 2.0.0** (semver). Version increments are determined automatically by `semantic-release` based on Conventional Commits in the default branch.

| Commit prefix | Version bump |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or `BREAKING CHANGE:` footer | major |

### 3.2 Publishing

Releases are published to the public npm registry under the `@zbdpay` scope. Publishing uses **npm OIDC Trusted Publishing** via GitHub Actions — no long-lived npm tokens are stored in repository secrets. The workflow exchanges a short-lived GitHub OIDC token for a scoped npm publish token at release time.

The npm package provenance attestation (`--provenance` flag) MUST be enabled on every publish run so consumers can verify the build origin.

### 3.3 Binary Distribution

The `zbdw` binary is distributed via the npm package `bin` field. Consumers install it with `npm install -g @zbdpay/agent-wallet` or run it directly with `npx @zbdpay/agent-wallet`. No separate binary distribution channel is required in Phase 1.

### 3.4 Release Branch

The `main` branch is the only release branch. Pre-release channels (`next`, `beta`) may be added but are not required for Phase 1.

### 3.5 Changelog

`semantic-release` generates `CHANGELOG.md` automatically from commit history. Manual edits to `CHANGELOG.md` are forbidden.

### 3.6 No Manual Publishes

Publishing by running `npm publish` locally is forbidden. All publishes go through the CI release workflow.

---

## 4. Compatibility Policy

### 4.1 CLI Output Contract

Every command MUST output valid JSON to stdout on success. On error, the CLI MUST output a JSON error object to stdout and exit with code 1. No human-readable text is permitted on stdout — verbose/debug output goes to stderr.

```json
{ "error": "invalid_api_key", "message": "API key rejected by ZBD API" }
```

Exit codes:
- `0` — success
- `1` — any error (API failure, validation error, config missing, etc.)

### 4.2 L402 / LNURL Compatibility

The `fetch` subcommand MUST work with any bLIP-26-compliant L402 server, not just ZBD-hosted endpoints. Compatibility is inherited from `@zbdpay/agent-fetch` — the CLI MUST NOT add ZBD-specific assumptions to the fetch flow.

LNURL-pay destination resolution for `send` is delegated to the ZBD API (`POST /v0/ln-address/pay`). The CLI MUST NOT resolve LNURL endpoints directly.

### 4.3 Supported Send Destinations

The `send` command MUST auto-detect destination format and route accordingly:

| Format | Detection | ZBD Endpoint |
|---|---|---|
| BOLT11 invoice | starts with `lnbc` | `POST /v0/payments` |
| Lightning Address | contains `@` | `POST /v0/ln-address/pay` |
| ZBD Gamertag | starts with `@` | `POST /v0/gamertag/pay` |
| LNURL | starts with `lnurl` | `POST /v0/ln-address/pay` |

Any destination format not in this table MUST cause the command to exit 1 with an `unsupported_destination` error code.

### 4.4 Local-First Payment Lookup

The `payment <id>` command MUST check `~/.zbd-wallet/payments.json` first. If the record is found locally, it MUST be returned immediately without an API call. If not found locally, the CLI fetches from `GET /v0/charges/:id` and appends the result to the local file before returning.

### 4.5 ZBD API Version

This CLI targets the `v0` ZBD API surface. If ZBD introduces a `v1` API, a new major version of this package will be released.

### 4.6 Node.js Runtime

Minimum supported runtime: **Node.js 22 LTS**. No support for older Node.js versions.

### 4.7 Network

ZBD operates on mainnet only. No testnet or signet flag is supported or needed.

---

*Last updated: 2026-02-27. Maintained by the ZBD agent suite team.*

---

## 5. Onchain Payout Contract

### 5.1 Command Group

The `onchain` subcommand group exposes four commands:

| Command | Description |
|---|---|
| `zbdw onchain quote <amount_sats> <destination>` | Get a fee quote for an onchain payout |
| `zbdw onchain send <amount_sats> <destination> --accept-terms` | Create an onchain payout |
| `zbdw onchain status <payout_id>` | Fetch current payout status |
| `zbdw onchain retry-claim <payout_id>` | Re-enqueue claim workflow for a failed payout |

All four commands call `ZBD_AI_BASE_URL` (default `https://zbd.ai`) payout routes. No direct Boltz or onchain calls are made from the CLI.

### 5.2 Consent Requirement

`zbdw onchain send` MUST require the `--accept-terms` flag. This is a local preflight check that runs before API key resolution and before any outbound request.

If `--accept-terms` is absent, the command MUST exit 1 with:

```json
{"error":"accept_terms_required","message":"Onchain send requires --accept-terms to confirm consent"}
```

The CLI MUST NOT send `accept_terms: true` to the API unless the flag was explicitly provided. The API-side consent failure code is `invalid_consent` (HTTP 400).

### 5.3 Onchain Quote Output Contract

```json
{
  "quote_id": "q_001",
  "amount_sats": 10000,
  "fee_sats": 150,
  "total_sats": 10150,
  "destination": "bc1qexample...",
  "expires_at": "2026-02-27T00:05:00.000Z"
}
```

Required fields: `quote_id`, `amount_sats`, `fee_sats`, `total_sats`, `destination`, `expires_at`. If any are missing, the command MUST exit 1 with `onchain_payout_response_invalid`.

### 5.4 Onchain Send Output Contract

```json
{
  "payout_id": "payout_123",
  "status": "queued",
  "amount_sats": 10000,
  "destination": "bc1qexample...",
  "request_id": "req_abc123",
  "kickoff": {
    "enqueued": true,
    "workflow": "payout.workflow.root",
    "kickoff_id": "k_001"
  }
}
```

Required fields: `payout_id`, `status`, `amount_sats`, `destination`. `request_id` and `kickoff` fields are always present but may be `null`.

A successful `onchain send` MUST append a record to `~/.zbd-wallet/payments.json` with these additional fields:

```json
{
  "id": "payout_123",
  "type": "send",
  "amount_sats": 10000,
  "status": "queued",
  "timestamp": "2026-02-27T00:00:00.000Z",
  "source": "onchain",
  "onchain_network": "bitcoin",
  "onchain_address": "bc1qexample...",
  "onchain_payout_id": "payout_123"
}
```

### 5.5 Onchain Status Output Contract

```json
{
  "payout_id": "payout_123",
  "status": "broadcasting",
  "amount_sats": 10000,
  "destination": "bc1qexample...",
  "txid": null,
  "failure_code": null,
  "kickoff": {
    "enqueued": true,
    "workflow": "payout.workflow.root",
    "kickoff_id": "k_001"
  }
}
```

Fields `amount_sats`, `destination`, `txid`, and `failure_code` may be `null` when not yet available. `failure_code` is set when status is `failed_invoice_expired` or `failed_lockup`.

### 5.6 Retry-Claim Output Contract

```json
{
  "payout_id": "payout_123",
  "status": "queued",
  "kickoff": {
    "enqueued": true,
    "workflow": "payout.workflow.root",
    "kickoff_id": "k_002"
  }
}
```

`retry-claim` is only meaningful when the payout status is `failed_invoice_expired`. Calling it on a terminal-succeeded or non-retryable payout is a no-op at the API level.

### 5.7 Payout Status Values

Payout status values are deterministic, machine-readable, and lowercase snake_case:

| Status | Terminal | Meaning |
|---|---|---|
| `created` | no | Payout request accepted |
| `queued` | no | Payout queued for execution |
| `broadcasting` | no | Payout executing on network |
| `succeeded` | yes | Payout completed successfully |
| `failed_invoice_expired` | yes | Invoice expired before claim completed; retry-claim is available |
| `failed_lockup` | yes | Lockup or claim path failure |
| `refunded` | yes | Funds returned to source |
| `manual_review` | yes | Requires manual intervention |

### 5.8 Onchain Error Codes

| Error code | Trigger |
|---|---|
| `accept_terms_required` | `onchain send` called without `--accept-terms` |
| `onchain_payout_response_invalid` | API response missing required fields |
| `onchain_payout_request_failed` | Non-401 API error from payout service |
| `onchain_payout_unreachable` | Network failure reaching `ZBD_AI_BASE_URL` |
| `invalid_api_key` | 401 from payout API |

The API-side consent failure code is `invalid_consent` (HTTP 400). This is distinct from the CLI-side `accept_terms_required` which fires before any network call.
