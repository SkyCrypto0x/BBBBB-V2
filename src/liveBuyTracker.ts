import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { appConfig, ChainId } from "./config";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import { BuyBotSettings } from "./feature.buyBot";
import { globalAlertQueue } from "./queue";
import { getNewPairsHybrid, type SimplePairInfo } from "./utils/hybridApi";

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

interface PairRuntime {
  contract: ethers.Contract;
  token0: string;
  token1: string;
}

interface ChainRuntime {
  provider: ethers.providers.BaseProvider;
  pairs: Map<string, PairRuntime>;
  rpcUrl: string;
  isWebSocket: boolean;
}

const runtimes = new Map<ChainId, ChainRuntime>();

interface PremiumAlertData {
  usdValue: number;
  baseAmount: number;
  tokenAmount: number;
  tokenAmountDisplay: string;
  tokenSymbol: string;
  txHash: string;
  chain: ChainId;
  buyer: string;
  positionIncrease: number | null;
  marketCap: number;
  volume24h: number;
  priceUsd: number;
  pairAddress: string;
  pairLiquidityUsd: number;
}

// cooldown per group+pair
const lastAlertAt = new Map<string, number>();

// native price cache
const nativePriceCache = new Map<string, { value: number; ts: number }>();
const NATIVE_TTL_MS = 30_000;

// Dex pair info cache
const pairInfoCache = new Map<string, { value: any | null; ts: number }>();
const PAIR_INFO_TTL_MS = 15_000;

let syncTimer: NodeJS.Timeout | null = null;

export function startLiveBuyTracker(bot: Telegraf) {
  syncListeners(bot).catch((e) => console.error("Initial sync error:", e));
  syncTimer = setInterval(
    () => syncListeners(bot).catch((e) => console.error("Sync error:", e)),
    15_000
  );

  // -------------------------------
  // Start Hybrid New-Pool Watcher
  // -------------------------------
  const chainsToWatch: ChainId[] = ["bsc", "ethereum"]; // চাইলে config থেকে নিতে পারো

  for (const chain of chainsToWatch) {
    void scanNewPoolsLoop(chain);
  }
}

export async function shutdownLiveBuyTracker() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  for (const [chain, runtime] of runtimes.entries()) {
    for (const [addr, pr] of runtime.pairs.entries()) {
      try {
        pr.contract.removeAllListeners();
        console.log(`🧹 Removed listeners for ${chain}:${addr}`);
      } catch {
        // ignore
      }
    }

    const anyProv = runtime.provider as any;
    if (anyProv._websocket && typeof anyProv._websocket.close === "function") {
      try {
        anyProv._websocket.close();
      } catch {
        // ignore
      }
    }
  }

  runtimes.clear();
  console.log("🔻 LiveBuyTracker shutdown complete");
}

async function syncListeners(bot: Telegraf) {
  console.log("🔁 Syncing live listeners...");

  // Auto cleanup: je pair gulo kono group-e nei, segulo remove
  const activePairAddrs = new Set<string>();
  for (const settings of groupSettings.values()) {
    settings.allPairAddresses?.forEach((p) =>
      activePairAddrs.add(p.toLowerCase())
    );
  }

  for (const [chain, runtime] of runtimes.entries()) {
    for (const addr of runtime.pairs.keys()) {
      if (!activePairAddrs.has(addr)) {
        const pr = runtime.pairs.get(addr);
        if (pr) {
          try {
            pr.contract.removeAllListeners();
          } catch {
            // ignore
          }
          runtime.pairs.delete(addr);
          console.log(`Auto-removed dead pair ${chain}:${addr}`);
        }
      }
    }
  }

  const neededPairsByChain = new Map<ChainId, Set<string>>();

  for (const [, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
      if (validPairs.length > 0) {
        settings.allPairAddresses = validPairs.map((p) => p.address);
        markGroupSettingsDirty();
        console.log(
          `Auto-added ${validPairs.length} pools for ${settings.tokenAddress}`
        );
      }
    }

    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      continue;
    }

    let set = neededPairsByChain.get(chain);
    if (!set) {
      set = new Set<string>();
      neededPairsByChain.set(chain, set);
    }
    for (const pairAddr of settings.allPairAddresses) {
      set.add(pairAddr.toLowerCase());
    }
  }

  for (const [chain, neededPairs] of neededPairsByChain.entries()) {
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg) continue;

    let runtime = runtimes.get(chain);
    if (!runtime) {
      const isWs = chainCfg.rpcUrl.startsWith("wss");
      const provider = isWs
        ? new ethers.providers.WebSocketProvider(chainCfg.rpcUrl)
        : new ethers.providers.JsonRpcProvider(chainCfg.rpcUrl);

      runtime = {
        provider,
        pairs: new Map(),
        rpcUrl: chainCfg.rpcUrl,
        isWebSocket: isWs
      };
      runtimes.set(chain, runtime);
      console.log(`🔗 Connected to ${chain} RPC (${isWs ? "WS" : "HTTP"})`);
    } else if (runtime.isWebSocket) {
      const ws = (runtime.provider as any)._websocket;
      if (!ws || ws.readyState !== 1) {
        console.warn(`⚠️ WS dead for ${chain}, recreating provider...`);
        try {
          const newProv = new ethers.providers.WebSocketProvider(runtime.rpcUrl);
          for (const [addr, pr] of runtime.pairs.entries()) {
            try {
              pr.contract.removeAllListeners();
            } catch {
              // ignore
            }
            const newContract = new ethers.Contract(addr, PAIR_ABI, newProv);
            pr.contract = newContract;
            attachSwapListener(newContract, bot, chain, addr, {
              token0: pr.token0,
              token1: pr.token1
            });
          }
          runtime.provider = newProv;
          console.log(
            `✅ WS reconnected for ${chain} (${runtime.pairs.size} pairs reattached)`
          );
        } catch (e) {
          console.error(`❌ Failed to recreate WS provider for ${chain}`, e);
        }
      }
    }

    // cleanup unused pairs
    for (const addr of runtime.pairs.keys()) {
      if (!neededPairs.has(addr)) {
        const pr = runtime.pairs.get(addr)!;
        try {
          pr.contract.removeAllListeners();
        } catch {
          // ignore
        }
        runtime.pairs.delete(addr);
        console.log(`🧹 Stopped listening on pair ${chain}:${addr}`);
      }
    }

    // add new listeners
    for (const addr of neededPairs) {
      if (runtime.pairs.has(addr)) continue;

      try {
        const contract = new ethers.Contract(addr, PAIR_ABI, runtime.provider);

        let token0: string;
        let token1: string;

        try {
          [token0, token1] = await Promise.all([
            contract.token0(),
            contract.token1()
          ]);
        } catch (e: any) {
          console.log(
            `❌ Skipping non-standard pair ${addr} on ${chain}: ${
              e?.message || e
            }`
          );

          if (chain === "ethereum") {
            console.log(`🔄 Retrying token0/token1 for ${addr}...`);
            try {
              const retryToken0 = await contract.token0().catch(() => null);
              const retryToken1 = await contract.token1().catch(() => null);

              if (retryToken0 && retryToken1) {
                token0 = retryToken0;
                token1 = retryToken1;
                console.log(`✅ Retry success for ${addr}`);
              } else {
                console.log(
                  `❌ Retry still missing token0/token1 for ${addr}`
                );
                continue;
              }
            } catch (retryErr: any) {
              console.log(
                `❌ Retry failed for ${addr}: ${
                  retryErr?.message || retryErr
                }`
              );
              continue;
            }
          } else {
            continue;
          }
        }

        const t0 = token0.toLowerCase();
        const t1 = token1.toLowerCase();

        runtime.pairs.set(addr, { contract, token0: t0, token1: t1 });

        console.log(`🛰️ Listening on pair ${chain}:${addr.substring(0, 10)}…`);
        attachSwapListener(contract, bot, chain, addr, {
          token0: t0,
          token1: t1
        });
      } catch (e) {
        console.error(`Failed to attach listener to pair ${addr}`, e);
      }
    }
  }
}

// Manual clear for /clearcache
export async function clearLiveTrackerCaches(bot: Telegraf) {
  for (const [chain, runtime] of runtimes.entries()) {
    for (const [addr, pr] of runtime.pairs.entries()) {
      try {
        pr.contract.removeAllListeners();
      } catch {
        // ignore
      }
    }
    runtime.pairs.clear();

    const anyProv = runtime.provider as any;
    if (runtime.isWebSocket && anyProv._websocket && typeof anyProv._websocket.close === "function") {
      try {
        anyProv._websocket.close();
      } catch {
        // ignore
      }
    }
  }

  runtimes.clear();
  lastAlertAt.clear();
  pairInfoCache.clear();
  nativePriceCache.clear();

  setTimeout(() => {
    syncListeners(bot).catch((e) =>
      console.error("Sync error after clearcache:", e)
    );
  }, 2000);

  console.log("🧹 Manual cache clear triggered via /clearcache");
}

function attachSwapListener(
  contract: ethers.Contract,
  bot: Telegraf,
  chain: ChainId,
  addr: string,
  tokens: { token0: string; token1: string }
) {
  contract.on(
    "Swap",
    (
      sender,
      amount0In,
      amount1In,
      amount0Out,
      amount1Out,
      to,
      event
    ) => {
      handleSwap(
        bot,
        chain,
        addr,
        tokens,
        event.transactionHash,
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to,
        event.blockNumber
      );
    }
  );
}

async function handleSwap(
  bot: Telegraf,
  chain: ChainId,
  pairAddress: string,
  tokens: { token0: string; token1: string },
  txHash: string,
  amount0In: ethers.BigNumber,
  amount1In: ethers.BigNumber,
  amount0Out: ethers.BigNumber,
  amount1Out: ethers.BigNumber,
  to: string,
  blockNumber: number
) {
  const relatedGroups: [number, BuyBotSettings][] = [];

  for (const [groupId, settings] of groupSettings.entries()) {
    if (
      settings.chain === chain &&
      settings.allPairAddresses?.some(
        (p) => p.toLowerCase() === pairAddress.toLowerCase()
      )
    ) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (relatedGroups.length === 0) return;

  const settings = relatedGroups[0][1];

  if (!settings.allPairAddresses || settings.allPairAddresses.length <= 1) {
    const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
    if (validPairs.length > 0) {
      settings.allPairAddresses = validPairs.map((p) => p.address);
      markGroupSettingsDirty();
      console.log(
        `🔎 Auto-filled ${validPairs.length} pools from DexScreener for ${settings.tokenAddress}`
      );
    }
  }

  const targetToken = settings.tokenAddress.toLowerCase();

  const isToken0 = tokens.token0 === targetToken;
  const isToken1 = tokens.token1 === targetToken;
  if (!isToken0 && !isToken1) return;

  const baseIn = isToken0 ? amount1In : amount0In;
  const tokenOut = isToken0 ? amount0Out : amount1Out;
  if (baseIn.lte(0) || tokenOut.lte(0)) return;

  const baseAmount = parseFloat(ethers.utils.formatUnits(baseIn, 18));

  let priceUsd = 0;
  let marketCap = 0;
  let volume24h = 0;
  let tokenSymbol = "TOKEN";
  let pairLiquidityUsd = 0;

  const pairKey = `${chain}:${pairAddress.toLowerCase()}`;
  const now = Date.now();
  let pairData: any | null = null;
  const cachedPair = pairInfoCache.get(pairKey);
  if (cachedPair && now - cachedPair.ts < PAIR_INFO_TTL_MS) {
    pairData = cachedPair.value;
  } else {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`
      );
      const data: any = await res.json();
      pairData = data?.pair || null;
      pairInfoCache.set(pairKey, { value: pairData, ts: now });
    } catch (e) {
      console.error("DexScreener fetch failed:", e);
    }
  }

  if (pairData) {
    const p = pairData;
    if (
      p.baseToken?.address.toLowerCase() === settings.tokenAddress.toLowerCase()
    ) {
      priceUsd = parseFloat(p.priceUsd || "0");
      tokenSymbol = p.baseToken.symbol || "TOKEN";
    } else if (
      p.quoteToken?.address.toLowerCase() ===
      settings.tokenAddress.toLowerCase()
    ) {
      const raw = parseFloat(p.priceUsd || "0");
      priceUsd = raw ? 1 / raw : 0;
      tokenSymbol = p.quoteToken.symbol || "TOKEN";
    }
    marketCap = p.fdv || 0;
    volume24h = p.volume?.h24 || 0;
    pairLiquidityUsd = p.liquidity?.usd || 0;
  }

  if (marketCap === 0 && priceUsd > 0) {
    const totalSupply = 1_000_000_000_000_000;
    marketCap = priceUsd * totalSupply;
  }

  // ✅ Token decimals on-chain theke
  let tokenDecimals = 18;
  try {
    const runtime = runtimes.get(chain);
    if (runtime?.provider) {
      const tokenContract = new ethers.Contract(
        settings.tokenAddress,
        ["function decimals() view returns (uint8)"],
        runtime.provider
      );
      const dec = await tokenContract.decimals();
      if (
        typeof dec === "number" &&
        Number.isFinite(dec) &&
        dec >= 0 &&
        dec <= 36
      ) {
        tokenDecimals = dec;
      }
    }
  } catch {
    console.warn(
      `Decimals fetch failed for ${settings.tokenAddress}, fallback to 18`
    );
  }

  // tokenOut → human units
  const rawTokenAmount = Number(
    ethers.utils.formatUnits(tokenOut, tokenDecimals)
  );

  // সুন্দর comma formatting
  const tokenAmountDisplay = rawTokenAmount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: rawTokenAmount < 1 ? 6 : 0
  });

  const nativePriceUsd = await getNativePrice(chain);
  const usdValue = baseAmount * nativePriceUsd;

  const MIN_POSITION_USD = 100;
  let positionIncrease: number | null = null;
  const buyer = ethers.utils.getAddress(to);

  if (usdValue >= MIN_POSITION_USD) {
    const prevBalance = await getPreviousBalance(
      chain,
      settings.tokenAddress,
      buyer,
      blockNumber - 1
    );
    const currentBalance = prevBalance + tokenOut.toBigInt();

    if (prevBalance > 0n) {
      const diff = currentBalance - prevBalance;
      const increase = Number((diff * 1000n) / prevBalance) / 10;
      positionIncrease = Math.round(increase);
    }
  }

  const tokenAmount = rawTokenAmount;

  for (const [groupId, s] of relatedGroups) {
    const alertData: PremiumAlertData = {
      usdValue,
      baseAmount,
      tokenAmount,
      tokenAmountDisplay,
      tokenSymbol,
      txHash,
      chain,
      buyer,
      positionIncrease,
      marketCap,
      volume24h,
      priceUsd,
      pairAddress,
      pairLiquidityUsd
    };

    globalAlertQueue.enqueue({
      groupId,
      run: () => sendPremiumBuyAlert(bot, groupId, s, alertData)
    });
  }
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"
  );
}

function shorten(addr: string, len = 6): string {
  if (!addr) return "";
  return `${addr.slice(0, len)}...${addr.slice(-len + 2)}`;
}

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    const s = m.toFixed(2);
    // 1.00M -> 1M
    return (s.endsWith(".00") ? s.slice(0, -3) : s) + "M";
  }
  if (value >= 1_000) {
    const k = Math.round(value / 1_000);
    return `${k}K`;
  }
  return value.toFixed(0);
}

/* ========= Extra helpers ========= */

async function sendPremiumBuyAlert(
  bot: Telegraf,
  groupId: number,
  settings: BuyBotSettings,
  data: PremiumAlertData
) {
  const {
    usdValue,
    baseAmount,
    tokenAmount,
    tokenAmountDisplay,
    tokenSymbol,
    txHash,
    chain,
    buyer,
    positionIncrease,
    marketCap,
    volume24h,
    pairAddress,
    pairLiquidityUsd
  } = data;

  const buyUsd = Math.round(usdValue);
  if (buyUsd < settings.minBuyUsd) return;
  if (settings.maxBuyUsd && buyUsd > settings.maxBuyUsd) return;

  const key = `${groupId}:${pairAddress.toLowerCase()}`;
  const now = Date.now();
  const cdMs = (settings.cooldownSeconds ?? 3) * 1000;
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < cdMs) return;
  lastAlertAt.set(key, now);

  const chainStr = String(chain).toLowerCase();

  let baseEmoji = "";
  let baseSymbolText = "";
  if (chainStr === "bsc") {
    baseEmoji = "🟡";
    baseSymbolText = "BNB";
  } else if (
    chainStr === "ethereum" ||
    chainStr === "eth" ||
    chainStr === "mainnet"
  ) {
    baseEmoji = "🔹";
    baseSymbolText = "ETH";
  } else if (chainStr === "base") {
    baseEmoji = "🟦";
    baseSymbolText = "ETH";
  } else if (chainStr === "arbitrum" || chainStr === "arb") {
    baseEmoji = "🌀";
    baseSymbolText = "ETH";
  } else if (chainStr === "solana" || chainStr === "sol") {
    baseEmoji = "🟢";
    baseSymbolText = "SOL";
  } else if (chainStr === "polygon" || chainStr === "matic") {
    baseEmoji = "🟣";
    baseSymbolText = "MATIC";
  } else {
    baseEmoji = "💠";
    baseSymbolText = "NATIVE";
  }

  const explorerBase =
    appConfig.chains[chain]?.explorer ||
    (chainStr === "bsc"
      ? "https://bscscan.com"
      : "https://etherscan.io");

  const safeTokenSymbol = escapeHtml(tokenSymbol);
  const safeBuyer = escapeHtml(shorten(buyer));
  const txUrl = `${explorerBase}/tx/${txHash}`;
  const addrUrl = `${explorerBase}/address/${buyer}`;
  const pairLink = `${explorerBase}/address/${pairAddress}`;

  const emojiCount = Math.floor(
    buyUsd / (settings.dollarsPerEmoji || 50)
  );
  const emojiBar = settings.emoji.repeat(Math.min(50, emojiCount));

  const mcText = marketCap > 0 ? (marketCap / 1_000_000).toFixed(2) : "0.00";

  let mainPairLp = pairLiquidityUsd;
  try {
    if (settings.allPairAddresses && settings.allPairAddresses.length > 0) {
      const mainPairs = await getAllValidPairs(settings.tokenAddress, chain);
      if (mainPairs.length > 0) {
        mainPairLp = mainPairs[0].liquidityUsd;
      }
    }
  } catch {
    // ignore
  }
  const lpText = formatCompactUsd(mainPairLp);

  const whaleLoadLine =
    positionIncrease !== null && positionIncrease > 500
      ? "🚀🚀 <b>WHALE LOADING!</b> 🚀🚀\n"
      : "";

  const volumeLine = `🔥 Volume (24h): $${volume24h >= 1_000_000
    ? (volume24h / 1_000_000).toFixed(1) + "M"
    : (volume24h / 1_000).toFixed(0) + "K"}`;

  const headerLine =
    buyUsd >= 5000
      ? "🐳 <b>WHALE INCOMING!!!</b> 🐳"
      : buyUsd >= 3000
      ? "🚨🚨 <b>BIG BUY DETECTED!</b> 🚨🚨"
      : buyUsd >= 1000
      ? "🟢🟢🟢 <b>Strong Buy</b> 🟢🟢🟢"
      : "🟢 <b>New Buy</b> 🟢\n";

  const dexScreenerUrl = `https://dexscreener.com/${chain}/${settings.pairAddress}`;
  const dexToolsUrl = `https://www.dextools.io/app/${
    chainStr === "bsc" ? "bsc" : "ether"
  }/pair-explorer/${settings.pairAddress}`;

  const message = `
${headerLine}
${whaleLoadLine}
💰 <b>$${buyUsd.toLocaleString()}</b> ${safeTokenSymbol} BUY
${emojiBar}

${baseEmoji} <b>${baseSymbolText}:</b> ${baseAmount.toFixed(
    4
  )} ($${buyUsd.toLocaleString()})
💳 ${safeTokenSymbol}: ${tokenAmountDisplay}

🔗 <a href="${pairLink}">View Pair</a> → $${lpText} LP

👤 Buyer: <a href="${addrUrl}">${safeBuyer}</a>
🔶 <a href="${txUrl}">View Transaction</a>
${
  positionIncrease !== null
    ? `🧠 <b>Position Increased: +${positionIncrease.toFixed(0)}%</b>\n`
    : ""
}📊 MC: $${mcText}M
${volumeLine}

🔗 <a href="${dexToolsUrl}">DexT</a> | <a href="${dexScreenerUrl}">DexS</a> | <a href="https://t.me/trending">Trending</a>
`.trim();

  const row: any[] = [];

  if (settings.tgGroupLink) {
    row.push({
      text: "👥 Join Group",
      url: settings.tgGroupLink
    });
  }

  row.push({
    text: "✉️ DM for Ads",
    url: "https://t.me/yourusername"
  });

  const keyboard: any = {
    inline_keyboard: [row]
  };

  try {
    if (settings.animationFileId) {
      await bot.telegram.sendAnimation(groupId, settings.animationFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageFileId) {
      await bot.telegram.sendPhoto(groupId, settings.imageFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageUrl) {
      const isGif = settings.imageUrl.toLowerCase().endsWith(".gif");
      if (isGif) {
        await bot.telegram.sendAnimation(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
      } else {
        await bot.telegram.sendPhoto(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
      }
    } else {
      await bot.telegram.sendMessage(groupId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    }
    console.log(`✅ Alert sent → $${buyUsd} to group ${groupId}`);
  } catch (err: any) {
    console.error(`Send failed to ${groupId}:`, err.message);
  }
}

/* ========= helpers ========= */

async function getAllValidPairs(
  tokenAddress: string,
  chain: ChainId
): Promise<Array<{ address: string; liquidityUsd: number }>> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );
    const data: any = await res.json();

    if (!data.pairs || data.pairs.length === 0) return [];

    return data.pairs
      .filter(
        (p: any) =>
          p.chainId === chain &&
          (p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase() ||
            p.quoteToken.address.toLowerCase() === tokenAddress.toLowerCase())
      )
      .filter((p: any) => p.liquidity?.usd > 1000)
      .map((p: any) => ({
        address: p.pairAddress,
        liquidityUsd: p.liquidity?.usd || 0
      }))
      .sort((a: any, b: any) => b.liquidityUsd - a.liquidityUsd);
  } catch (e: any) {
    console.error(
      `❌ getAllValidPairs error for token ${tokenAddress} on ${chain}: ${
        e?.message || e
      }`
    );
    return [];
  }
}

async function getNativePrice(chain: ChainId): Promise<number> {
  const now = Date.now();
  const cached = nativePriceCache.get(chain);
  if (cached && now - cached.ts < NATIVE_TTL_MS) {
    return cached.value;
  }

  let price = chain === "bsc" ? 875 : 3400;
  try {
    const symbol = chain === "bsc" ? "BNBUSDT" : "ETHUSDT";
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    const data: any = await res.json();
    price = parseFloat(data.price);
  } catch {
    // fallback
  }
  nativePriceCache.set(chain, { value: price, ts: now });
  return price;
}

async function getPreviousBalance(
  chain: ChainId,
  token: string,
  wallet: string,
  block: number
): Promise<bigint> {
  try {
    const runtime = runtimes.get(chain);
    if (!runtime) return 0n;

    const tokenContract = new ethers.Contract(
      token,
      ["function balanceOf(address) view returns (uint256)"],
      runtime.provider
    );

    const balance: ethers.BigNumber = await tokenContract.balanceOf(wallet, {
      blockTag: block
    });
    return balance.toBigInt();
  } catch {
    return 0n;
  }
}

// ----------------------------------------------------
// Hybrid new-pool scanner (DexScreener + GeckoTerminal)
// ----------------------------------------------------
async function scanNewPoolsLoop(chain: ChainId) {
  console.log(`🚀 Starting hybrid new-pool watcher for ${chain}...`);

  const POLL_INTERVAL_MS = 10_000;

  while (true) {
    try {
      const pairs: SimplePairInfo[] = await getNewPairsHybrid(
        chain,
        5000, // min liquidity USD
        600   // max age 10 min
      );

      if (pairs.length > 0) {
        console.log(`[HYBRID] ${chain}: ${pairs.length} fresh pools detected`);

        for (const p of pairs.slice(0, 5)) {
          console.log(
            `  • ${p.symbol} | ${p.address} | liq≈$${p.liquidityUsd.toFixed(
              0
            )} | age ${p.age}s | ${p.source}`
          );
        }
      }
    } catch (err) {
      console.error(`[HYBRID] ${chain} scanner error:`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
