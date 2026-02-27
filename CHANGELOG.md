## [1.1.0](https://github.com/zbdpay/agent-wallet/compare/1.0.3...1.1.0) (2026-02-27)

### Features

* add onchain payout commands with consent and status tooling ([6599401](https://github.com/zbdpay/agent-wallet/commit/65994014e920a94a598622e644675e969afa3e51))

## [1.1.0] (2026-02-26)

### Features

* add `paylink` command group (`create`, `get`, `list`, `cancel`) backed by `zbd.ai` paylinks API
  - `paylink create <amount_sats>` creates a hosted payment page at `https://zbd.ai/paylinks/<id>`
  - `paylink get <id>` fetches current state and syncs settlement to local `payments.json`
  - `paylink list` returns all paylinks with full lifecycle and timestamp fields
  - `paylink cancel <id>` transitions lifecycle to `dead` (terminal, irreversible)
  - lifecycle vocabulary: `created | active | paid | expired | dead`; terminal states are `paid`, `expired`, `dead`
  - settlement projection on `paylink get` appends `paylink_id`, `paylink_lifecycle`, `paylink_amount_sats` to payment history
  - idempotent append: repeated `paylink get` calls for the same settled payment do not create duplicate records
  - requires `ZBD_AI_BASE_URL` (default `https://zbd.ai`); uses `x-api-key` header for paylinks API

### Compatibility

* existing `payments.json` records without paylink metadata remain valid; paylink fields are additive
* `ZBD_WALLET_PAYLINKS` env var overrides local paylinks storage path (default `~/.zbd-wallet/paylinks.json`)


## [1.0.3](https://github.com/zbdpay/agent-wallet/compare/1.0.2...1.0.3) (2026-02-26)

### Bug Fixes

* send bolt11 fetch payments without amount ([af480aa](https://github.com/zbdpay/agent-wallet/commit/af480aa73c9033ef74224745accbcc99b7b0feb7))

## [1.0.2](https://github.com/zbdpay/agent-wallet/compare/1.0.1...1.0.2) (2026-02-26)

### Bug Fixes

* normalize wallet bin path for npm publish ([d97ebec](https://github.com/zbdpay/agent-wallet/commit/d97ebec6833cc1c2ffb9d369454629ebaaac392c))

## [1.0.1](https://github.com/zbdpay/agent-wallet/compare/1.0.0...1.0.1) (2026-02-26)

### Bug Fixes

* run cli when invoked from symlinked bin path ([8a2b0ce](https://github.com/zbdpay/agent-wallet/commit/8a2b0ce80dc14f9d82a315774d0e7e06a933981e))

## 1.0.0 (2026-02-26)

### Features

* initialize agent-wallet CLI with payment and fetch flows ([7e1667e](https://github.com/zbdpay/agent-wallet/commit/7e1667e8d6ac8e4dbdf99968293d829d5c7a5f13))

### Bug Fixes

* add npm token fallback to release workflow ([816584f](https://github.com/zbdpay/agent-wallet/commit/816584f581a459c7dc47904b4dc0bbd46dcff833))
* align static charge and withdraw flows with current API ([108cad2](https://github.com/zbdpay/agent-wallet/commit/108cad2f1537c68ee6394dc958ac35d42c4bedd3))
* prepare wallet package for npm release ([4f2a99f](https://github.com/zbdpay/agent-wallet/commit/4f2a99fa56003089c5b7deef4c3c3e06dc934756))
* switch release workflow to npm trusted publishing ([b2358f6](https://github.com/zbdpay/agent-wallet/commit/b2358f6c736f8e5dcf15fc292212ef5218d3c3e7))
* update semantic-release npm plugin for trusted publishing ([f9b164a](https://github.com/zbdpay/agent-wallet/commit/f9b164a7ea1da62af66ff2755b4c9d664cc5608c))
* upgrade semantic-release core for trusted publishing ([72f8b50](https://github.com/zbdpay/agent-wallet/commit/72f8b50c97b2c0bf2e0e323ca7cfe2e5797d161a))
