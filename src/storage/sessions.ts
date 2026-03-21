import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaymentChallengeContext } from "@axobot/mppx";
import type { LightningSessionHandle } from "@axobot/mppx";

export interface StoredMppSessionRecord {
  sessionId: string;
  url: string;
  challenge: PaymentChallengeContext;
  session: LightningSessionHandle;
  createdAt: string;
  lastUsedAt: string;
  status: "open" | "closed";
  closedAt?: string | undefined;
  lastCloseResult?: Record<string, unknown> | undefined;
}

interface SessionFileData {
  sessions: StoredMppSessionRecord[];
}

const EMPTY_DATA: SessionFileData = {
  sessions: [],
};

export function getSessionStorePath(): string {
  return process.env.ZBD_WALLET_SESSIONS ?? join(homedir(), ".zbd-wallet", "sessions.json");
}

async function readData(): Promise<SessionFileData> {
  try {
    const raw = await readFile(getSessionStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionFileData>;
    return {
      sessions: Array.isArray(parsed.sessions)
        ? (parsed.sessions as StoredMppSessionRecord[])
        : [],
    };
  } catch {
    return { ...EMPTY_DATA };
  }
}

async function writeData(data: SessionFileData): Promise<void> {
  const filePath = getSessionStorePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function saveStoredSession(record: StoredMppSessionRecord): Promise<void> {
  const data = await readData();
  const index = data.sessions.findIndex((entry) => entry.sessionId === record.sessionId);
  if (index >= 0) {
    data.sessions[index] = record;
  } else {
    data.sessions.push(record);
  }
  await writeData(data);
}

export async function getStoredSession(sessionId: string): Promise<StoredMppSessionRecord | null> {
  const data = await readData();
  return data.sessions.find((entry) => entry.sessionId === sessionId) ?? null;
}

export async function listStoredSessions(): Promise<StoredMppSessionRecord[]> {
  const data = await readData();
  return [...data.sessions].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
}
