import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PaylinkLifecycle = "created" | "active" | "paid" | "expired" | "dead";

export interface PaylinkMetadataRecord {
  id: string;
  status?: string;
  lifecycle?: PaylinkLifecycle;
  amount_sats?: number;
  created_at?: string;
  updated_at?: string;
  paid_payment_id?: string;
}

export function getPaylinksPath(): string {
  return process.env.ZBD_WALLET_PAYLINKS ?? join(homedir(), ".zbd-wallet", "paylinks.json");
}

export async function readPaylinks(): Promise<PaylinkMetadataRecord[]> {
  try {
    const raw = await readFile(getPaylinksPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRecords(parsed);
  } catch {
    return [];
  }
}

export async function listPaylinks(): Promise<PaylinkMetadataRecord[]> {
  return readPaylinks();
}

export async function appendPaylink(record: PaylinkMetadataRecord): Promise<void> {
  const path = getPaylinksPath();
  const current = await readPaylinks();
  current.push(record);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

export async function findPaylinkById(id: string): Promise<PaylinkMetadataRecord | null> {
  const current = await readPaylinks();
  return current.find((item) => item.id === id) ?? null;
}

function normalizeRecords(value: unknown): PaylinkMetadataRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: PaylinkMetadataRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const source = item as Record<string, unknown>;
    const id = asString(source.id);
    if (!id) {
      continue;
    }

    const record: PaylinkMetadataRecord = { id };

    const status = asString(source.status);
    if (status) {
      record.status = status;
    }

    const lifecycle = asPaylinkLifecycle(source.lifecycle);
    if (lifecycle) {
      record.lifecycle = lifecycle;
    }

    const amountSats = toNumber(source.amount_sats);
    if (amountSats !== null) {
      record.amount_sats = amountSats;
    }

    const createdAt = asString(source.created_at);
    if (createdAt) {
      record.created_at = createdAt;
    }

    const updatedAt = asString(source.updated_at);
    if (updatedAt) {
      record.updated_at = updatedAt;
    }

    const paidPaymentId = asString(source.paid_payment_id);
    if (paidPaymentId) {
      record.paid_payment_id = paidPaymentId;
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

function asPaylinkLifecycle(value: unknown): PaylinkLifecycle | null {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }

  if (
    normalized === "created" ||
    normalized === "active" ||
    normalized === "paid" ||
    normalized === "expired" ||
    normalized === "dead"
  ) {
    return normalized;
  }

  return null;
}
