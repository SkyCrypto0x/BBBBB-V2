import { readFileSync } from "fs";
import path from "path";
import "dotenv/config";

export type ChainId = string;

export interface ChainConfig {
  rpcUrl: string;
  explorer: string;
}

export interface AppConfig {
  telegramBotToken: string;
  botUsername: string;
  defaultChain: ChainId;
  chains: Record<ChainId, ChainConfig>;
}

function safeReadConfigJson(): Partial<AppConfig> & {
  chains?: Record<string, Partial<ChainConfig>>;
} {
  try {
    const raw = readFileSync(path.join(__dirname, "..", "config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { chains: {} };
  }
}

const rawJson = safeReadConfigJson();

const chains: Record<ChainId, ChainConfig> = {
  bsc: {
    rpcUrl: process.env.BSC_RPC_URL || rawJson.chains?.bsc?.rpcUrl || "",
    explorer:
      process.env.BSC_EXPLORER ||
      rawJson.chains?.bsc?.explorer ||
      "https://bscscan.com"
  },
  ethereum: {
    rpcUrl:
      process.env.ETH_RPC_URL || rawJson.chains?.ethereum?.rpcUrl || "",
    explorer:
      process.env.ETH_EXPLORER ||
      rawJson.chains?.ethereum?.explorer ||
      "https://etherscan.io"
  }
  // চাইলে এখানে base, arb ইত্যাদি add করবি
};

export const appConfig: AppConfig = {
  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN || rawJson.telegramBotToken || "",
  botUsername: process.env.BOT_USERNAME || rawJson.botUsername || "",
  defaultChain:
    (process.env.DEFAULT_CHAIN as ChainId | undefined) ||
    (rawJson.defaultChain as ChainId | undefined) ||
    "bsc",
  chains
};

if (!appConfig.telegramBotToken) {
  throw new Error(
    "Missing TELEGRAM_BOT_TOKEN. Put it in .env (config.json-এ রাখা safe না)."
  );
}
