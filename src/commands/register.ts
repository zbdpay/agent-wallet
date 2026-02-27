import type { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  FileTokenCache,
  agentFetch,
  type PaidChallenge,
  type PaymentSettlement,
  type TokenCache,
} from "@zbdpay/agent-fetch";
import { loadWalletConfig, saveWalletConfig } from "../config/load-config.js";
import { CliError, writeJson } from "../output/json.js";
import {
  appendPayment,
  appendPaymentIfMissingById,
  findPaymentById,
  readPayments,
  type PaymentPaylinkLifecycle,
} from "../storage/payments.js";
import {
  cancelPaylink,
  createOnchainPayout,
  createReceiveInvoice,
  createPaylink,
  createStaticCharge,
  createWithdrawRequest,
  fetchOnchainPayout,
  fetchPaylink,
  fetchPaymentDetail,
  listPaylinks,
  quoteOnchainPayout,
  fetchWalletBalanceSats,
  retryOnchainClaim,
  fetchWithdrawStatus,
  registerWalletIdentity,
  resolveApiKey,
  sendPayment,
  type SendDestinationKind,
  type PaylinkResult,
} from "../wallet/client.js";

export function registerCommandGroups(program: Command): void {
  program
    .command("init")
    .description("Initialize wallet identity and local config")
    .option("--key <apiKey>", "API key for initialization")
    .action(async (options: { key?: string }) => {
      const existingConfig = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        flagKey: options.key,
        envKey: process.env.ZBD_API_KEY,
        configKey: existingConfig?.apiKey,
        allowConfigFallback: true,
      });

      const registration = await registerWalletIdentity(apiKey);

      await saveWalletConfig({
        apiKey,
        lightningAddress: registration.lightningAddress,
      });

      writeJson({
        lightningAddress: registration.lightningAddress,
        status: "ok",
      });
    });

  program
    .command("info")
    .description("Show wallet metadata from local configuration")
    .action(async () => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const balanceSats = await fetchWalletBalanceSats(apiKey);

      writeJson({
        lightningAddress: config?.lightningAddress ?? null,
        apiKey: "***",
        balance_sats: balanceSats,
      });
    });

  program
    .command("balance")
    .description("Get wallet balance")
    .action(async () => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const balanceSats = await fetchWalletBalanceSats(apiKey);
      writeJson({
        balance_sats: balanceSats,
      });
    });

  program
    .command("receive")
    .description("Create an invoice or static charge")
    .argument("[amount_sats]", "Amount to receive in sats")
    .argument("[description]", "Optional invoice description")
    .option("--static", "Create static charge")
    .action(async (amountSats?: string, description?: string, options?: { static?: boolean }) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      if (options?.static) {
        const fixedAmountSats =
          typeof amountSats === "string" && amountSats.trim().length > 0
            ? parseAmountSats(amountSats)
            : undefined;
        const result = await createStaticCharge(apiKey, {
          amountSats: fixedAmountSats,
          description,
        });
        await appendPayment({
          id: result.charge_id,
          type: "receive",
          amount_sats: fixedAmountSats ?? 0,
          status: result.status,
          timestamp: result.timestamp,
        });

        const output: Record<string, unknown> = {
          charge_id: result.charge_id,
        };
        if (result.lightning_address) {
          output.lightning_address = result.lightning_address;
        }
        if (result.lnurl) {
          output.lnurl = result.lnurl;
        }

        writeJson(output);
        return;
      }

      const amount = parseAmountSats(amountSats);
      const result = await createReceiveInvoice(apiKey, amount, description);

      await appendPayment({
        id: result.id,
        type: "receive",
        amount_sats: result.amount_sats,
        status: result.status,
        timestamp: result.timestamp,
      });

      writeJson({
        invoice: result.invoice,
        payment_hash: result.payment_hash,
        expires_at: result.expires_at,
      });
    });

  program
    .command("send")
    .description("Send payment to invoice, address, gamertag, or LNURL")
    .argument("<destination>", "Destination to pay")
    .argument("<amount_sats>", "Amount to send in sats")
    .action(async (destination: string, amountSats: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const amount = parseAmountSats(amountSats);
      const destinationType = detectDestination(destination);

      const result = await withLoadingDots("Sending payment", () =>
        sendPayment(apiKey, destination, amount, destinationType),
      );
      await appendPayment({
        id: result.payment_id,
        type: "send",
        amount_sats: result.amount_sats,
        fee_sats: result.fee_sats,
        status: result.status,
        timestamp: result.timestamp,
        preimage: result.preimage,
      });

      writeJson({
        payment_id: result.payment_id,
        fee_sats: result.fee_sats,
        status: result.status,
        preimage: result.preimage,
      });
    });

  program
    .command("payments")
    .description("List local payment history")
    .action(async () => {
      const payments = await readPayments();
      writeJson(payments);
    });

  program
    .command("payment")
    .description("Get payment detail by id")
    .argument("<id>", "Payment identifier")
    .action(async (id: string) => {
      const local = await findPaymentById(id);
      if (local) {
        writeJson(local);
        return;
      }

      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const detail = await fetchPaymentDetail(apiKey, id);
      await appendPayment({
        id: detail.id,
        type: detail.type,
        amount_sats: detail.amount_sats,
        fee_sats: detail.fee_sats,
        status: detail.status,
        timestamp: detail.timestamp,
        preimage: detail.preimage,
      });

      writeJson(detail);
    });

  const paylink = program
    .command("paylink")
    .description("Manage hosted paylinks");

  paylink
    .command("create")
    .description("Create a paylink")
    .argument("<amount_sats>", "Amount to collect in sats")
    .action(async (amountSats: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const amount = parseAmountSats(amountSats);
      const result = await createPaylink(apiKey, { amount_sats: amount });
      writeJson({
        id: result.id,
        url: result.url,
        status: result.status,
        lifecycle: result.lifecycle,
        amount_sats: result.amount_sats,
      });
    });

  paylink
    .command("get")
    .description("Get paylink details")
    .argument("<id>", "Paylink identifier")
    .action(async (id: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const result = await fetchPaylink(apiKey, id);
      await syncPaylinkSettlementProjection(apiKey, result);
      writeJson({
        id: result.id,
        url: result.url,
        status: result.status,
        lifecycle: result.lifecycle,
        amount_sats: result.amount_sats,
        created_at: result.created_at,
        updated_at: result.updated_at,
      });
    });

  paylink
    .command("list")
    .description("List paylinks")
    .action(async () => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const records = await listPaylinks(apiKey);
      writeJson({
        paylinks: records.map((result) => ({
          id: result.id,
          url: result.url,
          status: result.status,
          lifecycle: result.lifecycle,
          amount_sats: result.amount_sats,
          created_at: result.created_at,
          updated_at: result.updated_at,
        })),
      });
    });

  paylink
    .command("cancel")
    .description("Cancel a paylink")
    .argument("<id>", "Paylink identifier")
    .action(async (id: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const result = await cancelPaylink(apiKey, id);
      writeJson({
        id: result.id,
        url: result.url,
        status: result.status,
        lifecycle: result.lifecycle,
      });
    });

  const withdraw = program
    .command("withdraw")
    .description("Manage LNURL-withdraw flows")
    .argument("[amount_or_id]", "Amount in sats (create) or withdraw id (status)")
    .action(async (amountOrId?: string) => {
      if (typeof amountOrId !== "string" || amountOrId.trim().length === 0) {
        throw new CliError(
          "invalid_withdraw_usage",
          "Use `zbdw withdraw <amount_sats>`, `zbdw withdraw <withdraw_id>`, `zbdw withdraw create <amount_sats>`, or `zbdw withdraw status <withdraw_id>`",
        );
      }

      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const normalized = amountOrId.trim();
      if (/^\d+$/.test(normalized)) {
        const amount = parseAmountSats(normalized);
        const result = await createWithdrawRequest(apiKey, amount);
        writeJson({
          withdraw_id: result.withdraw_id,
          lnurl: result.lnurl,
        });
        return;
      }

      const result = await fetchWithdrawStatus(apiKey, normalized);
      writeJson(result);
    });

  withdraw
    .command("create")
    .description("Create a withdraw request")
    .argument("<amount_sats>", "Withdraw amount in sats")
    .action(async (amountSats: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const amount = parseAmountSats(amountSats);
      const result = await createWithdrawRequest(apiKey, amount);
      writeJson({
        withdraw_id: result.withdraw_id,
        lnurl: result.lnurl,
      });
    });

  withdraw
    .command("status")
    .description("Check withdraw request status")
    .argument("<withdraw_id>", "Withdraw identifier")
    .action(async (withdrawId: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const result = await fetchWithdrawStatus(apiKey, withdrawId);
      writeJson(result);
    });

  const onchain = program
    .command("onchain")
    .description("Manage onchain payout flows");

  onchain
    .command("quote")
    .description("Quote an onchain payout")
    .argument("<amount_sats>", "Amount to send in sats")
    .argument("<destination>", "Onchain destination address")
    .action(async (amountSats: string, destination: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const amount = parseAmountSats(amountSats);
      const result = await quoteOnchainPayout(apiKey, {
        amount_sats: amount,
        destination,
      });

      writeJson({
        quote_id: result.quote_id,
        amount_sats: result.amount_sats,
        fee_sats: result.fee_sats,
        total_sats: result.total_sats,
        destination: result.destination,
        expires_at: result.expires_at,
      });
    });

  onchain
    .command("send")
    .description("Create an onchain payout")
    .argument("<amount_sats>", "Amount to send in sats")
    .argument("<destination>", "Onchain destination address")
    .option("--payout-id <id>", "Optional idempotency payout id")
    .option("--accept-terms", "Accept onchain payout terms")
    .action(
      async (
        amountSats: string,
        destination: string,
        options?: { payoutId?: string; acceptTerms?: boolean },
      ) => {
        if (!options?.acceptTerms) {
          throw new CliError(
            "accept_terms_required",
            "Onchain send requires --accept-terms to confirm consent",
          );
        }

        const config = await loadWalletConfig();
        const { apiKey } = resolveApiKey({
          envKey: process.env.ZBD_API_KEY,
          configKey: config?.apiKey,
          allowConfigFallback: true,
        });

        const amount = parseAmountSats(amountSats);
        const result = await createOnchainPayout(apiKey, {
          amount_sats: amount,
          destination,
          accept_terms: true,
          payout_id: options?.payoutId,
        });

        await appendPayment({
          id: result.payout_id,
          type: "send",
          amount_sats: result.amount_sats,
          status: result.status,
          timestamp: new Date().toISOString(),
          source: "onchain",
          onchain_network: "bitcoin",
          onchain_address: result.destination,
          onchain_payout_id: result.payout_id,
        });

        writeJson({
          payout_id: result.payout_id,
          status: result.status,
          amount_sats: result.amount_sats,
          destination: result.destination,
          request_id: result.request_id,
          kickoff: result.kickoff,
        });
      },
    );

  onchain
    .command("status")
    .description("Get onchain payout status")
    .argument("<payout_id>", "Onchain payout identifier")
    .action(async (payoutId: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const result = await fetchOnchainPayout(apiKey, payoutId);
      writeJson(result);
    });

  onchain
    .command("retry-claim")
    .description("Retry claim workflow for an onchain payout")
    .argument("<payout_id>", "Onchain payout identifier")
    .action(async (payoutId: string) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const result = await retryOnchainClaim(apiKey, payoutId);
      writeJson(result);
    });

  program
    .command("fetch")
    .description("Run L402-aware fetch flow")
    .argument("<url>", "URL to fetch")
    .option("--method <method>", "HTTP method", "GET")
    .option("--data <json>", "Request body data")
    .option("--max-sats <amount>", "Max payment in sats")
    .action(async (url: string, options: { method: string; data?: string; maxSats?: string }) => {
      const config = await loadWalletConfig();
      const { apiKey } = resolveApiKey({
        envKey: process.env.ZBD_API_KEY,
        configKey: config?.apiKey,
        allowConfigFallback: true,
      });

      const requestInit = buildFetchRequestInit(options.method, options.data);
      const maxPaymentSats = parseMaxPaymentSats(options.maxSats);

      const tokenCache: TokenCache = new FileTokenCache(getTokenCachePath());
      let paymentId: string | null = null;
      let amountPaidSats: number | null = null;

      try {
        const response = await agentFetch(url, {
          requestInit,
          maxPaymentSats,
          tokenCache,
          pay: async (challenge) => {
            const payment = await withLoadingDots("Paying challenge", () =>
              sendPayment(apiKey, challenge.invoice, challenge.amountSats, "bolt11"),
            );
            paymentId = payment.payment_id;
            amountPaidSats = payment.amount_sats;
            return {
              preimage: payment.preimage ?? "",
              paymentId: payment.payment_id,
              amountPaidSats: payment.amount_sats,
            } satisfies PaidChallenge;
          },
          waitForPayment: async (pendingPaymentId) => {
            const detail = await fetchPaymentDetail(apiKey, pendingPaymentId);
            const settlementStatus = mapSettlementStatus(detail.status);
            if (settlementStatus === "completed") {
              paymentId = detail.id;
              amountPaidSats = detail.amount_sats;
              return {
                status: "completed",
                paymentId: detail.id,
                preimage: detail.preimage,
                amountPaidSats: detail.amount_sats,
              } satisfies PaymentSettlement;
            }

            if (settlementStatus === "failed") {
              return {
                status: "failed",
                paymentId: detail.id,
                failureReason: `payment_${detail.status}`,
              } satisfies PaymentSettlement;
            }

            return {
              status: "pending",
              paymentId: detail.id,
            } satisfies PaymentSettlement;
          },
        });

        writeJson({
          status: response.status,
          body: await parseResponseBody(response),
          payment_id: paymentId,
          amount_paid_sats: amountPaidSats,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("exceeds limit")) {
          throw new CliError("max_sats_exceeded", error.message);
        }

        throw error;
      }
    });
}

function parseAmountSats(value: string | undefined): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError("invalid_amount", "Amount in sats is required");
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new CliError("invalid_amount", "Amount must be a positive integer in sats", {
      amount_sats: value,
    });
  }

  const amount = Number(value.trim());
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new CliError("invalid_amount", "Amount must be a positive integer in sats", {
      amount_sats: value,
    });
  }

  return amount;
}

function buildFetchRequestInit(methodRaw: string, bodyData: string | undefined): RequestInit {
  const method = methodRaw.trim().toUpperCase();
  if (!method) {
    throw new CliError("invalid_method", "Method is required");
  }

  if (typeof bodyData !== "string") {
    return { method };
  }

  const payload = parseJsonBody(bodyData);
  return {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CliError("invalid_json", "--data must be valid JSON", {
      data: raw,
    });
  }
}

function parseMaxPaymentSats(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new CliError("invalid_max_sats", "--max-sats must be a non-negative integer", {
      max_sats: value,
    });
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError("invalid_max_sats", "--max-sats must be a non-negative integer", {
      max_sats: value,
    });
  }

  return parsed;
}

function getTokenCachePath(): string {
  return process.env.ZBD_WALLET_TOKEN_CACHE ?? join(homedir(), ".zbd-wallet", "token-cache.json");
}

function mapSettlementStatus(status: string): PaymentSettlement["status"] {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed" || normalized === "paid" || normalized === "settled") {
    return "completed";
  }

  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") {
    return "failed";
  }

  return "pending";
}

function mapPaylinkLifecycleFromSettlementStatus(
  settlementStatus: PaymentSettlement["status"],
  currentLifecycle: PaylinkResult["lifecycle"],
): PaymentPaylinkLifecycle {
  if (settlementStatus === "completed") {
    return "paid";
  }

  if (settlementStatus === "failed") {
    return currentLifecycle === "expired" ? "expired" : "dead";
  }

  return currentLifecycle === "created" || currentLifecycle === "active" ? currentLifecycle : "active";
}

async function syncPaylinkSettlementProjection(apiKey: string, paylink: PaylinkResult): Promise<void> {
  const settlementPaymentId = paylink.paid_payment_id ?? paylink.latest_attempt_id ?? paylink.active_attempt_id;
  if (!settlementPaymentId) {
    return;
  }

  const detail = await fetchPaymentDetail(apiKey, settlementPaymentId);
  const settlementStatus = mapSettlementStatus(detail.status);
  const projectedLifecycle = mapPaylinkLifecycleFromSettlementStatus(settlementStatus, paylink.lifecycle);

  await appendPaymentIfMissingById({
    id: detail.id,
    type: "receive",
    amount_sats: detail.amount_sats,
    status: settlementStatus,
    timestamp: detail.timestamp,
    preimage: detail.preimage,
    source: "paylink",
    paylink_id: paylink.id,
    paylink_attempt_id: settlementPaymentId,
    paylink_lifecycle: projectedLifecycle,
    paylink_amount_sats: paylink.amount_sats ?? undefined,
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  return raw;
}

function detectDestination(destination: string): SendDestinationKind {
  const normalized = destination.trim().toLowerCase();
  if (normalized.startsWith("lnbc")) {
    return "bolt11";
  }

  if (normalized.startsWith("lnurl")) {
    return "lnurl";
  }

  if (normalized.startsWith("@")) {
    return "gamertag";
  }

  if (normalized.includes("@")) {
    return "ln_address";
  }

  throw new CliError("unsupported_destination", "Unsupported destination format", {
    destination,
  });
}

async function withLoadingDots<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY || process.env.ZBDW_NO_PROGRESS === "1") {
    return run();
  }

  let frame = 0;
  const render = () => {
    const dotCount = frame % 4;
    frame += 1;
    const dots = ".".repeat(dotCount).padEnd(3, " ");
    process.stderr.write(`\r${label}${dots}`);
  };

  render();
  const timer = setInterval(render, 300);

  try {
    return await run();
  } finally {
    clearInterval(timer);
    process.stderr.write(`\r${" ".repeat(label.length + 3)}\r`);
  }
}
