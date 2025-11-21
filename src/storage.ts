import fs from "fs/promises";
import path from "path";
import type { BuyBotSettings } from "./feature.buyBot";

const STATE_FILE_PATH = path.join(__dirname, "..", "data", "groupSettings.json");

// runtime map used by both feature.buyBot and liveBuyTracker
export const groupSettings = new Map<number, BuyBotSettings>();

let saveTimer: NodeJS.Timeout | null = null;

export async function loadGroupSettingsFromDisk() {
  try {
    const raw = await fs.readFile(STATE_FILE_PATH, "utf8");
    const json = JSON.parse(raw) as Record<string, BuyBotSettings>;
    for (const [gid, settings] of Object.entries(json)) {
      groupSettings.set(Number(gid), settings);
    }
    console.log(`📂 Loaded ${groupSettings.size} group settings from disk`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      console.error("Failed to load groupSettings.json:", e);
    } else {
      console.log("ℹ️ No existing groupSettings.json, starting fresh");
    }
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveGroupSettingsNow, 1000);
}

export function markGroupSettingsDirty() {
  scheduleSave();
}

export async function saveGroupSettingsNow() {
  const obj: Record<string, BuyBotSettings> = {};
  for (const [gid, settings] of groupSettings.entries()) {
    obj[String(gid)] = settings;
  }
  try {
    await fs.mkdir(path.dirname(STATE_FILE_PATH), { recursive: true });
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify(obj, null, 2), "utf8");
    console.log("💾 groupSettings persisted to disk");
  } catch (e) {
    console.error("Failed to write groupSettings.json:", e);
  }
}
