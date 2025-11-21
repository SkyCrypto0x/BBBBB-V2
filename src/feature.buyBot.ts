import { Telegraf, Context, Markup } from "telegraf";
import { appConfig, ChainId } from "./config";
import { fetchTokenPairs, DexPair } from "./rpcAndApi";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import fetch from "node-fetch";

export interface BuyBotSettings {
  chain: ChainId;
  tokenAddress: string;
  pairAddress: string; // main pair
  allPairAddresses: string[];
  emoji: string;

  // visual options
  imageUrl?: string;          // http(s) url
  imageFileId?: string;       // uploaded photo file_id
  animationFileId?: string;   // uploaded gif/video file_id

  // filters
  minBuyUsd: number;
  maxBuyUsd?: number;
  dollarsPerEmoji: number;

  tgGroupLink?: string;
  autoPinDataPosts: boolean;
  autoPinKolAlerts: boolean;
  cooldownSeconds?: number;   // NEW: per group+pair cooldown in seconds
}

// groupId -> final premium settings
// ❌ OLD: local map এখানে ছিল, এখন storage.ts থেকে আসছে
// export const groupSettings = new Map<number, BuyBotSettings>();

type SetupStep =
  | "token"
  | "pair"
  | "emoji"
  | "image"
  | "minBuy"
  | "maxBuy"
  | "perEmoji"
  | "tgGroup";

interface BaseSetupState {
  step: SetupStep;
  settings: Partial<BuyBotSettings>;
}

// DM flow: per-user state (targetChatId = je group configure korche)
interface DmSetupState extends BaseSetupState {
  targetChatId: number;
}

// Group flow: per-group state
interface GroupSetupState extends BaseSetupState {}

const dmSetupStates = new Map<number, DmSetupState>(); // userId -> state
const groupSetupStates = new Map<number, GroupSetupState>(); // chatId -> state

type BotCtx = Context;

export function registerBuyBotFeature(bot: Telegraf<BotCtx>) {
  // 🔹 /start – DM + group premium UX
  bot.start(async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    const payload = (ctx as any).startPayload as string | undefined;

    // DM with payload: deep-link from group -> start wizard for that group
    if (chat.type === "private" && payload && payload.startsWith("setup_")) {
      const groupId = Number(payload.replace("setup_", ""));
      const userId = ctx.from!.id;

      dmSetupStates.set(userId, {
        step: "token",
        targetChatId: groupId,
        settings: {
          chain: appConfig.defaultChain
        }
      });

      await ctx.reply(
        "🕵️ <b>Premium Buy Bot Setup</b>\n\n" +
          "1️⃣ Send your <b>token contract address</b>\n" +
          "I'll auto-detect <u>all pools</u> from DexScreener and pick the main one.",
        { parse_mode: "HTML" }
      );
      return;
    }

    // DM normal /start – welcome + Add to group button
    if (chat.type === "private") {
      const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;

      await ctx.reply(
        "🕵️ <b>Premium Buy Bot</b>\n\n" +
          "• Tracks buys for your token\n" +
          "• Uses all DexScreener pools\n" +
          "• Min & max buy filters\n" +
          "• Custom emoji + GIF / image alerts\n\n" +
          "➊ Press the button below to <b>add me to your group</b>.\n" +
          "➋ In the group, use <code>/add</code> to configure.",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.url("➕ Add to group", addToGroupUrl)]
          ])
        }
      );
      return;
    }

    // Group /start – show premium control panel
    if (chat.type === "group" || chat.type === "supergroup") {
      await sendGroupHelp(ctx);
      return;
    }
  });

  // 🔹 /stop – stop alerts for this group
  bot.command("stop", async (ctx) => {
    await handleStopCommand(ctx);
  });

  // 🔹 /add – main premium entry point (group + DM)
  bot.command("add", async (ctx) => {
    await handleAddCommand(ctx);
  });

  // 🔹 /testbuy – premium-style test alert (with image/gif)
  bot.command("testbuy", async (ctx) => {
    await handleTestBuyCommand(ctx);
  });

  // Group inline button: "Set up here"
  bot.action("setup_here", async (ctx) => {
    const chat = ctx.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
      await ctx.answerCbQuery("Use this inside your project group.");
      return;
    }

    const chatId = chat.id;
    groupSetupStates.set(chatId, {
      step: "token",
      settings: { chain: appConfig.defaultChain }
    });

    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(
      "🕵️ <b>Group Setup Mode</b>\n\n" +
        "1️⃣ Reply with your <b>token contract address</b>.\n" +
        "I'll auto-detect all pools from DexScreener.",
      { parse_mode: "HTML" }
    );

    await ctx.answerCbQuery();
  });

  // 🔹 Text handler – DM + group wizard
  bot.on("text", async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();

    const text = ctx.message!.text.trim();

    // DM wizard
    if (chat.type === "private") {
      const userId = ctx.from!.id;
      const state = dmSetupStates.get(userId);
      if (!state) return next();

      await runSetupStep(ctx, state, text);
      return;
    }

    // Group wizard
    if (chat.type === "group" || chat.type === "supergroup") {
      const chatId = chat.id;
      const state = groupSetupStates.get(chatId);
      if (!state) return next(); // no active wizard

      await runSetupStep(ctx, state, text);
      return;
    }

    return next();
  });

  // 🔹 Photo / GIF handler – only used on “image” step
  bot.on(["photo", "animation"], async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();

    // find current state (DM or group)
    let state: BaseSetupState | undefined;

    if (chat.type === "private") {
      const userId = ctx.from!.id;
      state = dmSetupStates.get(userId);
    } else if (chat.type === "group" || chat.type === "supergroup") {
      state = groupSetupStates.get(chat.id);
    }

    if (!state || state.step !== "image") {
      return next();
    }

    // photo upload
    if ("photo" in ctx.message! && ctx.message!.photo?.length) {
      const photos = ctx.message!.photo;
      const best = photos[photos.length - 1];
      (state.settings as any).imageFileId = best.file_id;

      state.step = "minBuy";
      await ctx.reply(
        "📸 Image saved!\n\n5️⃣ Send <b>minimum $ buy</b> that will trigger an alert (e.g. 50).",
        { parse_mode: "HTML" }
      );
      return;
    }

    // gif / animation upload
    if ("animation" in ctx.message! && ctx.message!.animation) {
      const anim = ctx.message!.animation;
      (state.settings as any).animationFileId = anim.file_id;

      state.step = "minBuy";
      await ctx.reply(
        "🎞 GIF saved!\n\n5️⃣ Send <b>minimum $ buy</b> that will trigger an alert (e.g. 50).",
        { parse_mode: "HTML" }
      );
      return;
    }

    return next();
  });

  // 🔹 Inline button commands (Premium panel buttons) – now DIRECT actions
  bot.action("cmd_add", async (ctx) => {
    await ctx.answerCbQuery();
    await handleAddCommand(ctx);
  });

  bot.action("cmd_testbuy", async (ctx) => {
    await ctx.answerCbQuery();
    // force 250 USD test buy
    await handleTestBuyCommand(ctx, 250);
  });

  bot.action("cmd_stop", async (ctx) => {
    await ctx.answerCbQuery();
    await handleStopCommand(ctx);
  });
}

/* ======================
 *  COMMAND HANDLERS
 * ===================== */

async function handleStopCommand(ctx: Context) {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.reply("Use /stop inside the token group.");
    return;
  }

  const groupId = ctx.chat.id;
  if (groupSettings.has(groupId)) {
    groupSettings.delete(groupId);
    markGroupSettingsDirty(); // persist change
    await ctx.reply(
      "🛑 <b>Buy alerts stopped for this group!</b>\n\nTo start again, use /add",
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply("ℹ️ No active tracking in this group.");
  }

  await sendGroupHelp(ctx);
}

async function handleAddCommand(ctx: Context) {
  const chat = ctx.chat;
  if (!chat) return;

  // DM: politely explain flow (must come via group)
  if (chat.type === "private") {
    const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;
    await ctx.reply(
      "To configure a token, please:\n\n" +
        "1️⃣ Add me to your token's group\n" +
        "2️⃣ In the group, type <code>/add</code>\n" +
        "3️⃣ Tap <b>Set up in DM</b> or <b>Set up here</b>",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.url("➕ Add to group", addToGroupUrl)]
        ])
      }
    );
    return;
  }

  // Group: offer DM setup + in-group setup
  if (chat.type === "group" || chat.type === "supergroup") {
    const groupId = chat.id;
    const setupDmUrl = `https://t.me/${appConfig.botUsername}?start=setup_${groupId}`;

    // reset any previous state for this group
    groupSetupStates.delete(groupId);

    const text =
      "🕵️ <b>Premium Buy Bot Setup</b>\n\n" +
      "Choose how you want to configure:\n\n" +
      "• <b>Set up in DM</b> – full wizard in private chat (recommended)\n" +
      "• <b>Set up here</b> – answer questions directly in this group";

    await ctx.reply(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url("💬 Set up in DM", setupDmUrl),
          Markup.button.callback("🏠 Set up here", "setup_here")
        ]
      ])
    });

    return;
  }
}

async function handleTestBuyCommand(ctx: Context, forcedUsd?: number) {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("Use /testbuy inside a group where the bot is configured.");
    return;
  }

  const settings = groupSettings.get(chat.id);
  if (!settings) {
    await ctx.reply(
      "No settings yet for this group.\nRun <code>/add</code> to configure first.",
      { parse_mode: "HTML" }
    );
    return;
  }

  let usdVal: number;

  if (forcedUsd !== undefined) {
    usdVal = forcedUsd;
  } else {
    const text = (ctx as any).message?.text as string | undefined;
    const parts = text ? text.split(/\s+/) : [];
    usdVal = parts[1] ? Number(parts[1]) : 123;
  }

  if (isNaN(usdVal) || usdVal <= 0) {
    await ctx.reply("Usage: /testbuy 250   (amount in USD)");
    return;
  }

  // respect min/max filters
  if (usdVal < settings.minBuyUsd) {
    await ctx.reply(
      `🚫 Test buy $${usdVal.toFixed(
        2
      )} is below min buy $${settings.minBuyUsd.toFixed(2)} (alert skipped).`
    );
    return;
  }
  if (settings.maxBuyUsd && usdVal > settings.maxBuyUsd) {
    await ctx.reply(
      `🚫 Test buy $${usdVal.toFixed(
        2
      )} is above max buy $${settings.maxBuyUsd.toFixed(2)} (alert skipped).`
    );
    return;
  }

  const emojiCount = Math.min(
    30,
    Math.max(1, Math.round(usdVal / settings.dollarsPerEmoji))
  );
  const emojiBar = settings.emoji.repeat(emojiCount);
  const mainPairUrl = `https://dexscreener.com/${settings.chain}/${settings.pairAddress}`;

  const text =
    "🧠 <b>Premium Buy Alert (TEST)</b>\n\n" +
    `<b>$${usdVal.toFixed(2)} BUY!</b>\n` +
    `${emojiBar}\n\n` +
    `🪙 <b>Token:</b> <code>${shorten(settings.tokenAddress)}</code>\n` +
    `🧬 <b>Main pair:</b> <code>${shorten(settings.pairAddress)}</code>\n` +
    (settings.allPairAddresses.length > 1
      ? `🌊 <b>Total pools:</b> ${settings.allPairAddresses.length}\n`
      : "") +
    `📊 <a href="${mainPairUrl}">DexScreener chart</a>`;

  await sendVisualAlert(ctx, settings, text);
}

/* ======================
 *  SETUP WIZARD
 * ===================== */

async function runSetupStep(
  ctx: Context,
  state: BaseSetupState,
  text: string
): Promise<void> {
  switch (state.step) {
    case "token": {
      const tokenAddr = text.trim();

      // ✅ 8.2 – Strong EVM contract validation
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
        await ctx.reply(
          "❌ Invalid token address.\nPlease send a valid EVM contract (0x...).",
          { parse_mode: "HTML" }
        );
        return;
      }

      state.settings.tokenAddress = tokenAddr.toLowerCase();

      // 🔍 Auto-detect chain from DexScreener before fetching pools
      if (/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
        try {
          const tokenUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`;
          let res = await fetch(tokenUrl);
          let data: any = await res.json();

          let pairs: any[] = Array.isArray(data.pairs) ? data.pairs : [];

          // Debug – console e raw structure dekhte পারবি
          console.log(
            "DexScreener raw token response first pair:",
            JSON.stringify(pairs[0])
          );

          // tokens endpoint e jodi na paoa jay, search diye fallback
          if (!pairs.length) {
            const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${tokenAddr}`;
            const searchRes = await fetch(searchUrl);
            const searchData: any = await searchRes.json();
            if (Array.isArray(searchData.pairs)) {
              pairs = searchData.pairs;
              console.log(
                "Using DexScreener search() result, first pair:",
                JSON.stringify(pairs[0])
              );
            }
          }

          if (pairs.length > 0) {
            let detectedChain: any =
              pairs[0].chainId ??
              pairs[0].chain?.id ??
              pairs[0].chainName ??
              pairs[0].chain?.name;

            if (detectedChain) {
              detectedChain = String(detectedChain).toLowerCase();

              // normalize common variants
              if (detectedChain === "eth") detectedChain = "ethereum";
              if (detectedChain === "bnb" || detectedChain === "bsc")
                detectedChain = "bsc";
              if (detectedChain === "arb") detectedChain = "arbitrum";
              if (detectedChain === "matic") detectedChain = "polygon";
              if (detectedChain === "avax") detectedChain = "avalanche";
            }

            const supportedChains = [
              "ethereum",
              "bsc",
              "base",
              "arbitrum",
              "polygon",
              "avalanche"
            ];

            if (detectedChain && supportedChains.includes(detectedChain)) {
              state.settings.chain = detectedChain as ChainId;
              await ctx.reply(
                `🛰 <b>Detected chain:</b> <code>${detectedChain.toUpperCase()}</code>`,
                { parse_mode: "HTML" }
              );
            } else {
              console.log(
                "Unsupported/unknown chain from DexScreener:",
                detectedChain
              );
            }
          } else {
            console.log("No pairs in DexScreener token+search response");
          }
        } catch (e) {
          console.error("Chain auto-detect failed:", e);
        }
      }

      const chain = state.settings.chain || appConfig.defaultChain;

      await ctx.reply("🔎 Fetching pools from DexScreener…");

      const pairs = await fetchTokenPairs(chain, tokenAddr);
      if (!pairs.length) {
        state.step = "pair";
        await ctx.reply(
          "❌ No pools found for this token on DexScreener.\n\n" +
            "2️⃣ Please send the <b>pair address</b> (DEX pool) for your token.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const sorted = sortPairsByLiquidity(pairs);
      const main = sorted[0];
      const allAddresses = sorted.map((p) => p.pairAddress);

      state.settings.pairAddress = main.pairAddress;
      (state.settings as any).allPairAddresses = allAddresses;

      let summary =
        `✅ Found <b>${sorted.length}</b> pools on DexScreener.\n\n` +
        `<b>Main pair:</b>\n<code>${main.pairAddress}</code>\n\n`;

      if (sorted.length > 1) {
        const others = sorted
          .slice(1, 4)
          .map((p) => `• ${p.pairAddress}`)
          .join("\n");
        summary += `<b>Other pools (top liq):</b>\n${others}\n\n`;
      }

      await ctx.reply(
        summary + "3️⃣ Now send a <b>buy emoji</b> (e.g. 🐶, 🧠, 🚀).",
        {
          parse_mode: "HTML"
        }
      );

      state.step = "emoji";
      return;
    }

    case "pair": {
      state.settings.pairAddress = text;
      (state.settings as any).allPairAddresses = [text];
      state.step = "emoji";
      await ctx.reply(
        "3️⃣ Choose a buy emoji (send just one emoji, e.g. 🐶 or 🧠)."
      );
      return;
    }

    case "emoji": {
      state.settings.emoji = text;
      state.step = "image";
      await ctx.reply(
        "4️⃣ Send an <b>image / gif</b> (upload) or an <b>image/gif URL</b> to show in each buy alert, or type <code>skip</code>.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "image": {
      if (text.toLowerCase() === "skip") {
        state.step = "minBuy";
        await ctx.reply(
          "5️⃣ Send <b>minimum $ buy</b> that will trigger an alert (e.g. 50).",
          { parse_mode: "HTML" }
        );
        return;
      }

      (state.settings as any).imageUrl = text;
      state.step = "minBuy";
      await ctx.reply(
        "🖼 Image URL saved!\n\n5️⃣ Send <b>minimum $ buy</b> that will trigger an alert (e.g. 50).",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "minBuy": {
      const val = Number(text);
      if (isNaN(val) || val < 0) {
        await ctx.reply("Please send a valid number, e.g. 50");
        return;
      }
      state.settings.minBuyUsd = val;
      state.step = "maxBuy";
      await ctx.reply(
        "6️⃣ (Optional) Send <b>maximum $ buy</b> to alert (e.g. 50000), or type <code>skip</code>.\n" +
          "Useful if you don't want huge whales to spam alerts.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "maxBuy": {
      if (text.toLowerCase() !== "skip") {
        const val = Number(text);
        if (isNaN(val) || val <= 0) {
          await ctx.reply("Please send a positive number, or 'skip'.");
          return;
        }
        state.settings.maxBuyUsd = val;
      }
      state.settings.cooldownSeconds ??= 3; // default cooldown if user didn't set
      state.step = "perEmoji";
      await ctx.reply(
        "7️⃣ Send <b>$ per emoji</b> (e.g. 50 → every $50 = 1 emoji).\n\n" +
          "Example: $200 buy with $50 per emoji → 🐶🐶🐶🐶",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "perEmoji": {
      const val = Number(text);
      if (isNaN(val) || val <= 0) {
        await ctx.reply("Please send a positive number, e.g. 50");
        return;
      }
      state.settings.dollarsPerEmoji = val;
      state.step = "tgGroup";
      await ctx.reply(
        "8️⃣ (Optional) Send your <b>Telegram group link</b> for better embedding, or type <code>skip</code>.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "tgGroup": {
      if (text.toLowerCase() !== "skip") {
        state.settings.tgGroupLink = text;
      }

      const finalSettings: BuyBotSettings = {
        chain: (state.settings.chain || appConfig.defaultChain) as ChainId,
        tokenAddress: state.settings.tokenAddress!,
        pairAddress: state.settings.pairAddress!,
        allPairAddresses:
          (state.settings as any).allPairAddresses ||
          [state.settings.pairAddress!],
        emoji: state.settings.emoji || "🟢",
        imageUrl: state.settings.imageUrl,
        imageFileId: (state.settings as any).imageFileId,
        animationFileId: (state.settings as any).animationFileId,
        minBuyUsd: state.settings.minBuyUsd ?? 10,
        maxBuyUsd: state.settings.maxBuyUsd,
        dollarsPerEmoji: state.settings.dollarsPerEmoji ?? 50,
        tgGroupLink: state.settings.tgGroupLink,
        autoPinDataPosts: state.settings.autoPinDataPosts ?? false,
        autoPinKolAlerts: state.settings.autoPinKolAlerts ?? false,
        cooldownSeconds: state.settings.cooldownSeconds ?? 3 // ✅ default 3s per pair
      };

      const targetGroupId =
        (state as any).targetChatId || ctx.chat!.id;
      groupSettings.set(targetGroupId, finalSettings);
      markGroupSettingsDirty(); // ✅ persist to disk via storage.ts

      await ctx.reply(
        "✅ Setup complete! Buy alerts are now active in the group 🚀",
        { parse_mode: "HTML" }
      );

      // state cleanup
      if ((state as any).targetChatId) {
        dmSetupStates.delete(ctx.from!.id);
      } else {
        groupSetupStates.delete(ctx.chat!.id);
      }

      await sendGroupHelp(ctx);
      return;
    }
  }
}

/* ======================
 *  HELPERS
 * ===================== */

function sortPairsByLiquidity(pairs: DexPair[]): DexPair[] {
  return [...pairs].sort((a, b) => {
    const la = Number(a?.liquidity?.usd ?? 0);
    const lb = Number(b?.liquidity?.usd ?? 0);
    return lb - la;
  });
}

function shorten(addr: string, len = 6): string {
  if (!addr || addr.length <= len * 2) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

async function sendVisualAlert(ctx: Context, settings: BuyBotSettings, text: string) {
  // priority: animation > uploaded photo > url(gif) > url(image) > plain text
  if (settings.animationFileId) {
    await (ctx as any).replyWithAnimation(settings.animationFileId, {
      caption: text,
      parse_mode: "HTML"
    });
    return;
  }

  if (settings.imageFileId) {
    await (ctx as any).replyWithPhoto(settings.imageFileId, {
      caption: text,
      parse_mode: "HTML"
    });
    return;
  }

  if (settings.imageUrl) {
    if (settings.imageUrl.toLowerCase().endsWith(".gif")) {
      await (ctx as any).replyWithAnimation(settings.imageUrl, {
        caption: text,
        parse_mode: "HTML"
      });
    } else {
      await (ctx as any).replyWithPhoto(settings.imageUrl, {
        caption: text,
        parse_mode: "HTML"
      });
    }
    return;
  }

  await ctx.reply(text, { parse_mode: "HTML" });
}

async function sendGroupHelp(ctx: Context) {
  const active = groupSettings.has(ctx.chat!.id) ? "Active 🟢" : "Inactive 🔴";

  await ctx.reply(
    `<b>Premium Buy Bot</b>\n\nStatus: ${active}\n\n` +
      "Configure your token & alerts below 👇",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚙️ Add Token", callback_data: "cmd_add" }],
          [{ text: "🧪 Preview Alert", callback_data: "cmd_testbuy" }],
          [{ text: "🛑 Stop Alerts", callback_data: "cmd_stop" }]
        ]
      }
    }
  );
}
