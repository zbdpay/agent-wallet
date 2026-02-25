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

*Last updated: 2026-02-25. Maintained by the ZBD agent suite team.*
