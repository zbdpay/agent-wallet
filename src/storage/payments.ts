import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PaymentHistoryRecord {
  id: string;
  type: "send" | "receive";
  amount_sats: number;
  status: string;
  timestamp: string;
  fee_sats?: number;
  preimage?: string;
}

export function getPaymentsPath(): string {
  return process.env.ZBD_WALLET_PAYMENTS ?? join(homedir(), ".zbd-wallet", "payments.json");
}

export async function readPayments(): Promise<PaymentHistoryRecord[]> {
  try {
    const raw = await readFile(getPaymentsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRecords(parsed);
  } catch {
    return [];
  }
}

export async function appendPayment(record: PaymentHistoryRecord): Promise<void> {
  const path = getPaymentsPath();
  const current = await readPayments();
  current.push(record);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

export async function findPaymentById(id: string): Promise<PaymentHistoryRecord | null> {
  const current = await readPayments();
  return current.find((item) => item.id === id) ?? null;
}

function normalizeRecords(value: unknown): PaymentHistoryRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: PaymentHistoryRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = asString((item as Record<string, unknown>).id);
    const amountSats = toNumber((item as Record<string, unknown>).amount_sats);
    const status = asString((item as Record<string, unknown>).status);
    const timestamp = asString((item as Record<string, unknown>).timestamp);
    const typeValue = asString((item as Record<string, unknown>).type);
    if (!id || amountSats === null || !status || !timestamp) {
      continue;
    }

    const type: "send" | "receive" = typeValue === "receive" ? "receive" : "send";
    const record: PaymentHistoryRecord = {
      id,
      type,
      amount_sats: amountSats,
      status,
      timestamp,
    };

    const feeSats = toNumber((item as Record<string, unknown>).fee_sats);
    if (feeSats !== null) {
      record.fee_sats = feeSats;
    }

    const preimage = asString((item as Record<string, unknown>).preimage);
    if (preimage) {
      record.preimage = preimage;
    }

    records.push(record);
  }

  return records;
}

function asString(value: unknown): string | null {
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
