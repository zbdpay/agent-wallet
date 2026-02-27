import { CliError } from "../output/json.js";

const DEFAULT_ZBD_API_BASE_URL = "https://api.zbdpay.com";
const DEFAULT_ZBD_AI_BASE_URL = "https://zbd.ai";

interface WalletApiResponse {
  balance?: unknown;
  balanceMsat?: unknown;
  balance_msat?: unknown;
}

export interface ReceiveInvoiceResult {
  id: string;
  invoice: string;
  payment_hash: string | null;
  expires_at: string;
  amount_sats: number;
  status: string;
  timestamp: string;
}

export interface StaticChargeResult {
  charge_id: string;
  lightning_address: string | null;
  lnurl: string | null;
  status: string;
  timestamp: string;
}

export interface SendPaymentResult {
  payment_id: string;
  amount_sats: number;
  fee_sats: number;
  status: string;
  preimage?: string;
  timestamp: string;
}

export interface PaymentDetailResult {
  id: string;
  type: "send" | "receive";
  amount_sats: number;
  fee_sats: number;
  status: string;
  preimage?: string;
  timestamp: string;
}

export interface WithdrawCreateResult {
  withdraw_id: string;
  lnurl: string;
  status: string;
  amount_sats: number;
}

export interface WithdrawStatusResult {
  withdraw_id: string;
  status: string;
  amount_sats: number;
}

export type PaylinkLifecycle = "created" | "active" | "paid" | "expired" | "dead";

export interface PaylinkResult {
  id: string;
  url: string | null;
  status: string;
  lifecycle: PaylinkLifecycle;
  amount_mode?: "fixed" | "range";
  amount_sats: number | null;
  min_amount_sats?: number | null;
  max_amount_sats?: number | null;
  multi_use?: boolean;
  max_uses?: number | null;
  use_count?: number | null;
  metadata?: {
    title?: string;
    description?: string;
    order_id?: string;
    customer_ref?: string;
    campaign?: string;
  };
  created_at: string | null;
  updated_at: string | null;
  active_attempt_id?: string;
  latest_attempt_id?: string;
  paid_payment_id?: string;
}

export interface OnchainPayoutQuoteResult {
  quote_id: string;
  amount_sats: number;
  fee_sats: number;
  total_sats: number;
  destination: string;
  expires_at: string;
}

export interface OnchainPayoutCreateResult {
  payout_id: string;
  status: string;
  amount_sats: number;
  destination: string;
  request_id: string | null;
  kickoff: {
    enqueued: boolean;
    workflow: string | null;
    kickoff_id: string | null;
  };
}

export interface OnchainPayoutStatusResult {
  payout_id: string;
  status: string;
  amount_sats: number | null;
  destination: string | null;
  txid: string | null;
  failure_code: string | null;
  kickoff: {
    enqueued: boolean;
    workflow: string | null;
    kickoff_id: string | null;
  };
}

export interface OnchainPayoutRetryClaimResult {
  payout_id: string;
  status: string;
  kickoff: {
    enqueued: boolean;
    workflow: string | null;
    kickoff_id: string | null;
  };
}

export type SendDestinationKind = "bolt11" | "ln_address" | "gamertag" | "lnurl";

export function resolveApiKey(options: {
  flagKey?: string;
  envKey?: string;
  configKey?: string;
  allowConfigFallback: boolean;
}): { apiKey: string; keySource: "flag" | "env" | "config" } {
  const flagKey = normalizeApiKey(options.flagKey);
  if (flagKey) {
    return { apiKey: flagKey, keySource: "flag" };
  }

  const envKey = normalizeApiKey(options.envKey);
  if (envKey) {
    return { apiKey: envKey, keySource: "env" };
  }

  if (options.allowConfigFallback) {
    const configKey = normalizeApiKey(options.configKey);
    if (configKey) {
      return { apiKey: configKey, keySource: "config" };
    }
  }

  throw new CliError("missing_api_key", "API key is required. Provide --key or set ZBD_API_KEY.");
}

export async function registerWalletIdentity(apiKey: string): Promise<{ lightningAddress: string }> {
  const registrationBaseUrl = getZbdAiBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${registrationBaseUrl}/api/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKey }),
    });
  } catch {
    throw new CliError(
      "register_unreachable",
      `Failed to reach registration service at ${registrationBaseUrl}`,
    );
  }

  const body = await safeJson(response);
  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError("invalid_api_key", "API key rejected by ZBD API");
    }

    throw new CliError("register_failed", "Failed to register wallet identity", {
      status: response.status,
      response: body,
    });
  }

  const lightningAddress = pickString(
    body,
    ["lightningAddress"],
    ["lightning_address"],
    ["data", "lightningAddress"],
    ["data", "lightning_address"],
  );

  if (!lightningAddress) {
    throw new CliError("register_failed", "Registration response missing lightningAddress");
  }

  return { lightningAddress };
}

export async function fetchWalletBalanceSats(apiKey: string): Promise<number> {
  const response = await fetch(`${getZbdApiBaseUrl()}/v0/wallet`, {
    method: "GET",
    headers: {
      apikey: apiKey,
    },
  });

  const body = await safeJson(response);

  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError("invalid_api_key", "API key rejected by ZBD API");
    }

    throw new CliError("wallet_request_failed", "Failed to fetch wallet balance", {
      status: response.status,
      response: body,
    });
  }

  const payload = (body && typeof body === "object" ? body : null) as WalletApiResponse | null;
  const msatValue = parseMsatValue(payload);
  if (msatValue === null) {
    throw new CliError("wallet_response_invalid", "Wallet response missing msat balance value");
  }

  return Math.floor(msatValue / 1000);
}

export async function createReceiveInvoice(
  apiKey: string,
  amountSats: number,
  description = "Payment request",
): Promise<ReceiveInvoiceResult> {
  const amountMsats = String(amountSats * 1000);
  const descriptionValue = description.trim() || "Payment request";
  const body = await requestZbd(apiKey, "/v0/charges", {
    method: "POST",
    body: JSON.stringify({ amount: amountMsats, description: descriptionValue }),
  });

  const invoice = pickString(
    body,
    ["invoice"],
    ["invoiceRequest"],
    ["invoice_request"],
    ["bolt11"],
    ["data", "invoice", "request"],
    ["data", "invoice"],
    ["data", "invoiceRequest"],
    ["data", "invoice_request"],
    ["data", "bolt11"],
  );
  const paymentHash = pickString(
    body,
    ["payment_hash"],
    ["paymentHash"],
    ["data", "payment_hash"],
    ["data", "paymentHash"],
  );
  const expiresAt = pickString(
    body,
    ["expires_at"],
    ["expiresAt"],
    ["invoice_expires_at"],
    ["invoiceExpiresAt"],
    ["data", "expires_at"],
    ["data", "expiresAt"],
    ["data", "invoice_expires_at"],
    ["data", "invoiceExpiresAt"],
  );
  const id = pickString(body, ["id"], ["charge_id"], ["data", "id"], ["data", "charge_id"]) ?? paymentHash;

  if (!invoice || !expiresAt || !id) {
    throw new CliError("receive_failed", "Invoice response missing required fields");
  }

  return {
    id,
    invoice,
    payment_hash: paymentHash ?? null,
    expires_at: expiresAt,
    amount_sats: amountSats,
    status: pickStatus(body, "pending"),
    timestamp: pickTimestamp(body),
  };
}

export async function createStaticCharge(
  apiKey: string,
  options?: { amountSats?: number; description?: string },
): Promise<StaticChargeResult> {
  const fixedAmountMsats =
    typeof options?.amountSats === "number" ? String(options.amountSats * 1000) : null;
  const bodyPayload = {
    minAmount: fixedAmountMsats ?? "1000",
    maxAmount: fixedAmountMsats ?? "500000000",
    description: options?.description?.trim() || "Payment request",
  };

  const body = await requestZbd(apiKey, "/v0/static-charges", {
    method: "POST",
    body: JSON.stringify(bodyPayload),
  });

  const chargeId = pickString(body, ["id"], ["charge_id"], ["data", "id"], ["data", "charge_id"]);
  const lightningAddress = pickString(
    body,
    ["lightning_address"],
    ["lightningAddress"],
    ["identifier"],
    ["data", "lightning_address"],
    ["data", "lightningAddress"],
    ["data", "identifier"],
  );
  const lnurl = pickString(
    body,
    ["lnurl"],
    ["invoice", "request"],
    ["data", "lnurl"],
    ["data", "invoice", "request"],
  );

  if (!chargeId || (!lightningAddress && !lnurl)) {
    throw new CliError("receive_failed", "Static charge response missing required fields");
  }

  return {
    charge_id: chargeId,
    lightning_address: lightningAddress ?? null,
    lnurl: lnurl ?? null,
    status: pickStatus(body, "active"),
    timestamp: pickTimestamp(body),
  };
}

export async function sendPayment(
  apiKey: string,
  destination: string,
  amountSats: number,
  kind: SendDestinationKind,
): Promise<SendPaymentResult> {
  let path = "/v0/payments";
  let payload: Record<string, unknown> = {
    amount: amountSats,
  };

  if (kind === "bolt11") {
    payload = {
      invoice: destination,
    };
  } else if (kind === "ln_address" || kind === "lnurl") {
    path = "/v0/ln-address/send-payment";
    payload = {
      lnAddress: destination,
      amount: String(amountSats * 1000),
      comment: "Sent via zbdw",
    };
  } else {
    path = "/v0/gamertag/send-payment";
    const normalizedGamertag = destination.trim().replace(/^@+/, "");
    if (!normalizedGamertag) {
      throw new CliError("invalid_gamertag", "Gamertag destination is invalid", {
        destination,
      });
    }

    payload = {
      gamertag: normalizedGamertag,
      amount: String(amountSats * 1000),
      description: "Sent via zbdw",
    };
  }

  const body = await requestZbd(apiKey, path, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const paymentId = pickString(body, ["id"], ["payment_id"], ["paymentId"], ["data", "id"], ["data", "payment_id"]);
  if (!paymentId) {
    throw new CliError("send_failed", "Payment response missing payment id");
  }

  const feeSats = parseSats(body, {
    msatPaths: [["fee"], ["feeMsat"], ["fee_msat"], ["data", "fee"], ["data", "feeMsat"], ["data", "fee_msat"]],
    satPaths: [["fee_sats"], ["feeSats"], ["data", "fee_sats"], ["data", "feeSats"]],
    fallback: 0,
  });

  return {
    payment_id: paymentId,
    amount_sats: amountSats,
    fee_sats: feeSats,
    status: pickStatus(body, "pending"),
    preimage: pickString(body, ["preimage"], ["data", "preimage"]) ?? undefined,
    timestamp: pickTimestamp(body),
  };
}

export async function fetchPaymentDetail(apiKey: string, id: string): Promise<PaymentDetailResult> {
  const body = await requestZbd(apiKey, `/v0/charges/${encodeURIComponent(id)}`, {
    method: "GET",
  });

  const paymentId = pickString(body, ["id"], ["payment_id"], ["paymentId"], ["charge_id"], ["data", "id"]) ?? id;
  const amountSats = parseSats(body, {
    msatPaths: [["amount"], ["amountMsat"], ["amount_msat"], ["data", "amount"], ["data", "amountMsat"], ["data", "amount_msat"]],
    satPaths: [["amount_sats"], ["amountSats"], ["data", "amount_sats"], ["data", "amountSats"]],
    fallback: 0,
  });
  const feeSats = parseSats(body, {
    msatPaths: [["fee"], ["feeMsat"], ["fee_msat"], ["data", "fee"], ["data", "feeMsat"], ["data", "fee_msat"]],
    satPaths: [["fee_sats"], ["feeSats"], ["data", "fee_sats"], ["data", "feeSats"]],
    fallback: 0,
  });

  const typeRaw = pickString(body, ["type"], ["kind"], ["data", "type"]) ?? "send";

  return {
    id: paymentId,
    type: typeRaw.toLowerCase() === "receive" ? "receive" : "send",
    amount_sats: amountSats,
    fee_sats: feeSats,
    status: pickStatus(body, "pending"),
    preimage: pickString(body, ["preimage"], ["data", "preimage"]) ?? undefined,
    timestamp: pickTimestamp(body),
  };
}

export async function createWithdrawRequest(apiKey: string, amountSats: number): Promise<WithdrawCreateResult> {
  const amountMsats = String(amountSats * 1000);
  const body = await requestZbd(apiKey, "/v0/withdrawal-requests", {
    method: "POST",
    body: JSON.stringify({ amount: amountMsats, description: "Withdrawal request" }),
  });

  const withdrawId = pickString(
    body,
    ["id"],
    ["withdraw_id"],
    ["withdrawId"],
    ["withdrawalRequestId"],
    ["data", "id"],
    ["data", "withdraw_id"],
    ["data", "withdrawId"],
    ["data", "withdrawalRequestId"],
  );
  const lnurlRaw = pickString(
    body,
    ["lnurl"],
    ["invoice", "request"],
    ["invoice", "uri"],
    ["invoice", "fastRequest"],
    ["invoice", "fastUri"],
    ["fastRequest"],
    ["fastUri"],
    ["data", "lnurl"],
    ["data", "invoice", "request"],
    ["data", "invoice", "uri"],
    ["data", "invoice", "fastRequest"],
    ["data", "invoice", "fastUri"],
    ["data", "fastRequest"],
    ["data", "fastUri"],
  );
  const lnurl = lnurlRaw ? normalizeLightningUri(lnurlRaw) : null;

  if (!withdrawId || !lnurl) {
    throw new CliError("withdraw_failed", "Withdraw creation response missing required fields");
  }

  return {
    withdraw_id: withdrawId,
    lnurl,
    status: pickStatus(body, "pending"),
    amount_sats: amountSats,
  };
}

export async function fetchWithdrawStatus(apiKey: string, withdrawId: string): Promise<WithdrawStatusResult> {
  const body = await requestZbd(apiKey, `/v0/withdrawal-requests/${encodeURIComponent(withdrawId)}`, {
    method: "GET",
  });

  const id = pickString(body, ["id"], ["withdraw_id"], ["withdrawId"], ["data", "id"], ["data", "withdraw_id"]) ?? withdrawId;

  const amountSats = parseSats(body, {
    msatPaths: [["amount"], ["amountMsat"], ["amount_msat"], ["data", "amount"], ["data", "amountMsat"], ["data", "amount_msat"]],
    satPaths: [["amount_sats"], ["amountSats"], ["data", "amount_sats"], ["data", "amountSats"]],
    fallback: 0,
  });

  return {
    withdraw_id: id,
    status: pickStatus(body, "pending"),
    amount_sats: amountSats,
  };
}

export async function createPaylink(
  apiKey: string,
  payload: {
    amount_sats?: number;
    min_amount_sats?: number;
    max_amount_sats?: number;
    multi_use?: boolean;
    max_uses?: number | null;
    metadata?: {
      title?: string;
      description?: string;
      order_id?: string;
      customer_ref?: string;
      campaign?: string;
    };
  },
): Promise<PaylinkResult> {
  const body = await requestZbdAiPaylinks(apiKey, "/api/paylinks", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return toPaylinkResult(body);
}

export async function fetchPaylink(apiKey: string, id: string): Promise<PaylinkResult> {
  const body = await requestZbdAiPaylinks(apiKey, `/api/paylinks/${encodeURIComponent(id)}`, {
    method: "GET",
  });

  return toPaylinkResult(body, id);
}

export async function listPaylinks(apiKey: string): Promise<PaylinkResult[]> {
  const body = await requestZbdAiPaylinks(apiKey, "/api/paylinks", {
    method: "GET",
  });

  const directList = getAtPath(body, ["paylinks"]);
  if (Array.isArray(directList)) {
    return directList.map((item) => toPaylinkResult(item));
  }

  if (Array.isArray(body)) {
    return body.map((item) => toPaylinkResult(item));
  }

  return [];
}

export async function cancelPaylink(apiKey: string, id: string): Promise<PaylinkResult> {
  const body = await requestZbdAiPaylinks(apiKey, `/api/paylinks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });

  return toPaylinkResult(body, id);
}

export async function quoteOnchainPayout(
  apiKey: string,
  payload: { amount_sats: number; destination: string },
): Promise<OnchainPayoutQuoteResult> {
  const body = await requestZbdAiOnchainPayouts(apiKey, "/api/payouts/quote", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const source = getOnchainPayoutSource(body);
  const quoteId = pickString(source, ["quote_id"], ["quoteId"]);
  const amountSats = parseSats(source, {
    satPaths: [["amount_sats"], ["amountSats"]],
    msatPaths: [["amount_msat"], ["amountMsat"]],
  });
  const feeSats = parseSats(source, {
    satPaths: [["fee_sats"], ["feeSats"]],
    msatPaths: [["fee_msat"], ["feeMsat"]],
  });
  const totalSats = parseSats(source, {
    satPaths: [["total_sats"], ["totalSats"]],
    msatPaths: [["total_msat"], ["totalMsat"]],
  });
  const destination = pickString(source, ["destination"]);
  const expiresAt = pickString(source, ["expires_at"], ["expiresAt"]);

  if (!quoteId || !destination || !expiresAt || amountSats <= 0 || totalSats <= 0) {
    throw new CliError("onchain_payout_response_invalid", "Onchain payout quote response missing required fields");
  }

  return {
    quote_id: quoteId,
    amount_sats: amountSats,
    fee_sats: feeSats,
    total_sats: totalSats,
    destination,
    expires_at: expiresAt,
  };
}

export async function createOnchainPayout(
  apiKey: string,
  payload: { amount_sats: number; destination: string; accept_terms: boolean; payout_id?: string },
): Promise<OnchainPayoutCreateResult> {
  const body = await requestZbdAiOnchainPayouts(apiKey, "/api/payouts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const source = getOnchainPayoutSource(body);
  const payoutId = pickString(source, ["payout_id"], ["payoutId"]);
  const status = pickString(source, ["status"]);
  const amountSats = parseSats(source, {
    satPaths: [["amount_sats"], ["amountSats"]],
    msatPaths: [["amount_msat"], ["amountMsat"]],
  });
  const destination = pickString(source, ["destination"]);

  if (!payoutId || !status || amountSats <= 0 || !destination) {
    throw new CliError("onchain_payout_response_invalid", "Onchain payout create response missing required fields");
  }

  return {
    payout_id: payoutId,
    status,
    amount_sats: amountSats,
    destination,
    request_id: pickString(source, ["request_id"], ["requestId"]),
    kickoff: parseKickoff(source),
  };
}

export async function fetchOnchainPayout(apiKey: string, payoutId: string): Promise<OnchainPayoutStatusResult> {
  const body = await requestZbdAiOnchainPayouts(apiKey, `/api/payouts/${encodeURIComponent(payoutId)}`, {
    method: "GET",
  });

  const source = getOnchainPayoutSource(body);
  const id = pickString(source, ["payout_id"], ["payoutId"]) ?? payoutId;
  const status = pickString(source, ["status"]) ?? "unknown";

  return {
    payout_id: id,
    status,
    amount_sats: parseOptionalSats(source, {
      satPaths: [["amount_sats"], ["amountSats"]],
      msatPaths: [["amount_msat"], ["amountMsat"]],
    }),
    destination: pickString(source, ["destination"]),
    txid: pickString(source, ["txid"]),
    failure_code: pickString(source, ["failure_code"], ["failureCode"]),
    kickoff: parseKickoff(source),
  };
}

export async function retryOnchainClaim(apiKey: string, payoutId: string): Promise<OnchainPayoutRetryClaimResult> {
  const body = await requestZbdAiOnchainPayouts(apiKey, `/api/payouts/${encodeURIComponent(payoutId)}/retry-claim`, {
    method: "POST",
  });

  const source = getOnchainPayoutSource(body);
  const id = pickString(source, ["payout_id"], ["payoutId"]) ?? payoutId;
  const status = pickString(source, ["status"]) ?? "queued";

  return {
    payout_id: id,
    status,
    kickoff: parseKickoff(source),
  };
}

function parseMsatValue(payload: WalletApiResponse | null): number | null {
  if (!payload) {
    return null;
  }

  const candidates = [
    payload.balanceMsat,
    payload.balance_msat,
    payload.balance,
    getAtPath(payload, ["data", "balanceMsat"]),
    getAtPath(payload, ["data", "balance_msat"]),
    getAtPath(payload, ["data", "balance"]),
  ];

  for (const value of candidates) {
    const numeric = toNumber(value);
    if (numeric !== null) {
      return numeric;
    }
  }

  const satsCandidates = [
    getAtPath(payload, ["balanceSats"]),
    getAtPath(payload, ["balance_sats"]),
    getAtPath(payload, ["data", "balanceSats"]),
    getAtPath(payload, ["data", "balance_sats"]),
  ];

  for (const value of satsCandidates) {
    const numeric = toNumber(value);
    if (numeric !== null) {
      return numeric * 1000;
    }
  }

  return null;
}

function normalizeApiKey(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function pickString(payload: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    const value = getAtPath(payload, path);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function getAtPath(payload: unknown, path: string[]): unknown {
  let current = payload;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

async function safeJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function requestZbd(apiKey: string, path: string, init: { method: string; body?: string }): Promise<unknown> {
  const apiBaseUrl = getZbdApiBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        apikey: apiKey,
        "content-type": "application/json",
      },
      body: init.body,
    });
  } catch {
    throw new CliError("wallet_unreachable", `Failed to reach ZBD API at ${apiBaseUrl}`);
  }

  const body = await safeJson(response);
  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError("invalid_api_key", "API key rejected by ZBD API");
    }

    throw new CliError("wallet_request_failed", "ZBD API request failed", {
      status: response.status,
      response: body,
      path,
    });
  }

  const success = getAtPath(body, ["success"]);
  if (success === false) {
    throw new CliError(
      "wallet_request_failed",
      pickString(body, ["message"], ["error"], ["errorString"]) ?? "ZBD API request failed",
      {
        status: response.status,
        response: body,
        path,
      },
    );
  }

  return body;
}

async function requestZbdAiPaylinks(
  apiKey: string,
  path: string,
  init: { method: string; body?: string },
): Promise<unknown> {
  const apiBaseUrl = getZbdAiBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        apikey: apiKey,
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: init.body,
    });
  } catch {
    throw new CliError("paylink_unreachable", `Failed to reach paylinks API at ${apiBaseUrl}`);
  }

  const body = await safeJson(response);
  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError("invalid_api_key", "API key rejected by paylinks API");
    }

    const apiErrorCode = pickString(body, ["error"]);
    const apiErrorMessage = pickString(body, ["message"]);
    throw new CliError(
      apiErrorCode ?? "paylink_request_failed",
      apiErrorMessage ?? "Paylinks API request failed",
      {
        status: response.status,
        response: body,
        path,
      },
    );
  }

  const success = getAtPath(body, ["success"]);
  if (success === false) {
    throw new CliError(
      pickString(body, ["error"]) ?? "paylink_request_failed",
      pickString(body, ["message"], ["errorString"]) ?? "Paylinks API request failed",
      {
        status: response.status,
        response: body,
        path,
      },
    );
  }

  return body;
}

async function requestZbdAiOnchainPayouts(
  apiKey: string,
  path: string,
  init: { method: string; body?: string },
): Promise<unknown> {
  const apiBaseUrl = getZbdAiBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        apikey: apiKey,
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: init.body,
    });
  } catch {
    throw new CliError("onchain_payout_unreachable", `Failed to reach onchain payout API at ${apiBaseUrl}`);
  }

  const body = await safeJson(response);
  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError("invalid_api_key", "API key rejected by onchain payout API");
    }

    throw new CliError(
      pickString(body, ["error"]) ?? "onchain_payout_request_failed",
      pickString(body, ["message"], ["errorString"]) ?? "Onchain payout API request failed",
      {
        status: response.status,
        response: body,
        path,
      },
    );
  }

  const success = getAtPath(body, ["success"]);
  if (success === false) {
    throw new CliError(
      pickString(body, ["error"]) ?? "onchain_payout_request_failed",
      pickString(body, ["message"], ["errorString"]) ?? "Onchain payout API request failed",
      {
        status: response.status,
        response: body,
        path,
      },
    );
  }

  return body;
}

function normalizeLightningUri(value: string): string {
  if (value.toLowerCase().startsWith("lightning:")) {
    return value.slice("lightning:".length);
  }

  return value;
}

function parseSats(
  payload: unknown,
  options: {
    msatPaths: string[][];
    satPaths: string[][];
    fallback?: number;
  },
): number {
  for (const path of options.satPaths) {
    const value = toNumber(getAtPath(payload, path));
    if (value !== null) {
      return Math.floor(value);
    }
  }

  for (const path of options.msatPaths) {
    const value = toNumber(getAtPath(payload, path));
    if (value !== null) {
      return Math.floor(value / 1000);
    }
  }

  return options.fallback ?? 0;
}

function parseOptionalSats(
  payload: unknown,
  options: {
    msatPaths: string[][];
    satPaths: string[][];
  },
): number | null {
  for (const path of options.satPaths) {
    const value = toNumber(getAtPath(payload, path));
    if (value !== null) {
      return Math.floor(value);
    }
  }

  for (const path of options.msatPaths) {
    const value = toNumber(getAtPath(payload, path));
    if (value !== null) {
      return Math.floor(value / 1000);
    }
  }

  return null;
}

function getOnchainPayoutSource(payload: unknown): unknown {
  return getAtPath(payload, ["data"]) ?? payload;
}

function parseKickoff(payload: unknown): { enqueued: boolean; workflow: string | null; kickoff_id: string | null } {
  const kickoff = getAtPath(payload, ["kickoff"]);
  if (!kickoff || typeof kickoff !== "object") {
    return {
      enqueued: false,
      workflow: null,
      kickoff_id: null,
    };
  }

  return {
    enqueued: getAtPath(kickoff, ["enqueued"]) === true,
    workflow: pickString(kickoff, ["workflow"]),
    kickoff_id: pickString(kickoff, ["kickoff_id"], ["kickoffId"]),
  };
}

function toPaylinkResult(payload: unknown, fallbackId?: string): PaylinkResult {
  const source = getAtPath(payload, ["paylink"]) ?? getAtPath(payload, ["data"]) ?? payload;
  const id =
    pickString(source, ["id"], ["paylink_id"], ["paylinkId"]) ??
    pickString(payload, ["id"], ["paylink_id"], ["paylinkId"]) ??
    fallbackId;
  if (!id) {
    throw new CliError("paylink_response_invalid", "Paylink response missing id");
  }

  const status =
    pickString(source, ["status"], ["state"]) ?? pickString(payload, ["status"], ["state"]) ?? "created";
  const lifecycleRaw =
    pickString(source, ["lifecycle"], ["paylink_lifecycle"], ["state"]) ??
    pickString(payload, ["lifecycle"], ["paylink_lifecycle"], ["state"]) ??
    status;

  const amountSats = parseSats(source, {
    msatPaths: [["amount_msat"], ["amountMsat"]],
    satPaths: [["amount_sats"], ["amountSats"], ["amount"]],
  });
  const hasAmount =
    toNumber(getAtPath(source, ["amount_sats"])) !== null ||
    toNumber(getAtPath(source, ["amountSats"])) !== null ||
    toNumber(getAtPath(source, ["amount"])) !== null ||
    toNumber(getAtPath(source, ["amount_msat"])) !== null ||
    toNumber(getAtPath(source, ["amountMsat"])) !== null;

  return {
    id,
    url:
      pickString(source, ["url"], ["checkout_url"], ["checkoutUrl"], ["paylink_url"], ["paylinkUrl"]) ??
      pickString(payload, ["url"], ["checkout_url"], ["checkoutUrl"], ["paylink_url"], ["paylinkUrl"]) ??
      null,
    status,
    lifecycle: parsePaylinkLifecycle(lifecycleRaw),
    amount_mode:
      pickString(source, ["amount_mode"], ["amountMode"], ["config", "amount_mode"], ["config", "amountMode"]) ===
      "range"
        ? "range"
        : "fixed",
    amount_sats: hasAmount ? amountSats : null,
    min_amount_sats: toNumber(getAtPath(source, ["min_amount_sats"])) ?? toNumber(getAtPath(source, ["minAmountSats"])),
    max_amount_sats: toNumber(getAtPath(source, ["max_amount_sats"])) ?? toNumber(getAtPath(source, ["maxAmountSats"])),
    multi_use: getAtPath(source, ["multi_use"]) === true || getAtPath(source, ["multiUse"]) === true,
    max_uses:
      toNumber(getAtPath(source, ["max_uses"])) ?? toNumber(getAtPath(source, ["maxUses"])) ??
      (getAtPath(source, ["max_uses"]) === null || getAtPath(source, ["maxUses"]) === null ? null : undefined),
    use_count: toNumber(getAtPath(source, ["use_count"])) ?? toNumber(getAtPath(source, ["useCount"])),
    metadata:
      getAtPath(source, ["metadata"]) && typeof getAtPath(source, ["metadata"]) === "object"
        ? {
            title: pickString(getAtPath(source, ["metadata"]), ["title"]) ?? undefined,
            description: pickString(getAtPath(source, ["metadata"]), ["description"]) ?? undefined,
            order_id: pickString(getAtPath(source, ["metadata"]), ["order_id"]) ?? undefined,
            customer_ref: pickString(getAtPath(source, ["metadata"]), ["customer_ref"]) ?? undefined,
            campaign: pickString(getAtPath(source, ["metadata"]), ["campaign"]) ?? undefined,
          }
        : undefined,
    created_at:
      pickString(source, ["created_at"], ["createdAt"], ["timestamp"]) ??
      pickString(payload, ["created_at"], ["createdAt"], ["timestamp"]) ??
      null,
    updated_at:
      pickString(source, ["updated_at"], ["updatedAt"]) ??
      pickString(payload, ["updated_at"], ["updatedAt"]) ??
      null,
    active_attempt_id:
      pickString(payload, ["activeAttempt", "id"], ["active_attempt", "id"], ["attempt", "id"]) ??
      undefined,
    latest_attempt_id: pickString(payload, ["latestAttempt", "id"], ["latest_attempt", "id"]) ?? undefined,
    paid_payment_id:
      pickString(
        source,
        ["paid_payment_id"],
        ["paidPaymentId"],
        ["window", "paidPaymentId"],
        ["window", "paid_payment_id"],
      ) ??
      pickString(payload, ["paid_payment_id"], ["paidPaymentId"]) ??
      undefined,
  };
}

function parsePaylinkLifecycle(value: string): PaylinkLifecycle {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "created" ||
    normalized === "active" ||
    normalized === "paid" ||
    normalized === "expired" ||
    normalized === "dead"
  ) {
    return normalized;
  }

  if (normalized === "completed") {
    return "paid";
  }

  if (normalized === "cancelled") {
    return "dead";
  }

  return "created";
}

function pickStatus(payload: unknown, fallback: string): string {
  return (
    pickString(payload, ["status"], ["state"], ["data", "status"], ["data", "state"]) ?? fallback
  );
}

function pickTimestamp(payload: unknown): string {
  return (
    pickString(
      payload,
      ["timestamp"],
      ["created_at"],
      ["createdAt"],
      ["updated_at"],
      ["updatedAt"],
      ["data", "timestamp"],
      ["data", "created_at"],
      ["data", "createdAt"],
      ["data", "updated_at"],
      ["data", "updatedAt"],
    ) ?? new Date().toISOString()
  );
}

function getZbdApiBaseUrl(): string {
  return process.env.ZBD_API_BASE_URL ?? DEFAULT_ZBD_API_BASE_URL;
}

function getZbdAiBaseUrl(): string {
  return process.env.ZBD_AI_BASE_URL ?? DEFAULT_ZBD_AI_BASE_URL;
}
