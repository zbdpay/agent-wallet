import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WalletConfig {
  apiKey?: string;
  lightningAddress?: string;
}

export function getWalletConfigPath(): string {
  return process.env.ZBD_WALLET_CONFIG ?? join(homedir(), ".zbd-wallet", "config.json");
}

export async function loadWalletConfig(): Promise<WalletConfig | null> {
  try {
    const raw = await readFile(getWalletConfigPath(), "utf8");
    return JSON.parse(raw) as WalletConfig;
  } catch {
    return null;
  }
}

export async function saveWalletConfig(config: WalletConfig): Promise<void> {
  const path = getWalletConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
