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
  lightning_address: string;
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

export async function createStaticCharge(apiKey: string): Promise<StaticChargeResult> {
  const body = await requestZbd(apiKey, "/v0/static-charges", {
    method: "POST",
    body: JSON.stringify({}),
  });

  const chargeId = pickString(body, ["id"], ["charge_id"], ["data", "id"], ["data", "charge_id"]);
  const lightningAddress = pickString(
    body,
    ["lightning_address"],
    ["lightningAddress"],
    ["data", "lightning_address"],
    ["data", "lightningAddress"],
  );

  if (!chargeId || !lightningAddress) {
    throw new CliError("receive_failed", "Static charge response missing required fields");
  }

  return {
    charge_id: chargeId,
    lightning_address: lightningAddress,
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
      amount: amountSats,
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
  const body = await requestZbd(apiKey, "/v0/withdrawal-requests", {
    method: "POST",
    body: JSON.stringify({ amount: amountSats }),
  });

  const withdrawId = pickString(body, ["id"], ["withdraw_id"], ["withdrawId"], ["data", "id"], ["data", "withdraw_id"]);
  const lnurl = pickString(body, ["lnurl"], ["data", "lnurl"]);

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

  return body;
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
