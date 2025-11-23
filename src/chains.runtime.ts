import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { appConfig, ChainId } from "./config";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import { BuyBotSettings } from "./feature.buyBot";
import { globalAlertQueue } from "./queue";
import { getNewPairsHybrid, type SimplePairInfo } from "./utils/hybridApi";
import { sendPremiumBuyAlert, PremiumAlertData } from "./alerts.buy";

// ────────────────── V2 / V3 / V4 Swap ABIs ──────────────────
export const PAIR_V2_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

export const PAIR_V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

export const PAIR_V4_ABI = [
  "event Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint256 feeProtocol)"
];

export interface PairRuntime {
  v2: ethers.Contract;
  v3?: ethers.Contract;
  v4?: ethers.Contract;
  token0: string;
  token1: string;
  targetToken: string; // track which token this pair is for
}

export interface ChainRuntime {
  provider: ethers.providers.BaseProvider;
  pairs: Map<string, PairRuntime>;
  rpcUrl: string;
  isWebSocket: boolean;
}

export const runtimes = new Map<ChainId, ChainRuntime>();

// native price cache
const nativePriceCache = new Map<string, { value: number; ts: number }>();
const NATIVE_TTL_MS = 30_000;

// Dex pair info cache
const pairInfoCache = new Map<string, { value: any | null; ts: number }>();
const PAIR_INFO_TTL_MS = 15_000;

// helpers – clear caches from /clearcache
export function clearChainCaches() {
  pairInfoCache.clear();
  nativePriceCache.clear();
}

// ────────────────── SWAP LISTENER ATTACH (V2+V3+V4) ──────────────────

export function attachSwapListener(
  bot: Telegraf,
  chain: ChainId,
  addr: string,
  provider: ethers.providers.BaseProvider,
  tokens: { token0: string; token1: string },
  targetToken: string
): PairRuntime {
  const targetTokenLower = targetToken.toLowerCase();

  // V2
  const v2 = new ethers.Contract(addr, PAIR_V2_ABI, provider);
  v2.on(
    "Swap",
    (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
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

  // V3
  const v3 = new ethers.Contract(addr, PAIR_V3_ABI, provider);
  v3.on(
    "Swap",
    (sender, recipient, amount0, amount1, _p, _l, _t, event) => {
      try {
        const a0 = BigInt(amount0.toString());
        const a1 = BigInt(amount1.toString());

        const isToken0 = tokens.token0 === targetTokenLower;
        const isBuy = (isToken0 && a0 < 0n) || (!isToken0 && a1 < 0n);
        if (!isBuy) return;

        const amount0In = a0 > 0n ? a0 : 0n;
        const amount1In = a1 > 0n ? a1 : 0n;
        const amount0Out = a0 < 0n ? -a0 : 0n;
        const amount1Out = a1 < 0n ? -a1 : 0n;

        handleSwap(
          bot,
          chain,
          addr,
          tokens,
          event.transactionHash,
          ethers.BigNumber.from(amount0In),
          ethers.BigNumber.from(amount1In),
          ethers.BigNumber.from(amount0Out),
          ethers.BigNumber.from(amount1Out),
          recipient,
          event.blockNumber
        );
      } catch (e) {
        console.error("V3 Swap handler error:", e);
      }
    }
  );

  // V4
  const v4 = new ethers.Contract(addr, PAIR_V4_ABI, provider);
  v4.on(
    "Swap",
    (sender, recipient, amount0, amount1, _p, _l, _t, _fee, event) => {
      try {
        const a0 = BigInt(amount0.toString());
        const a1 = BigInt(amount1.toString());

        const isToken0 = tokens.token0 === targetTokenLower;
        const isBuy = (isToken0 && a0 < 0n) || (!isToken0 && a1 < 0n);
        if (!isBuy) return;

        const amount0In = a0 > 0n ? a0 : 0n;
        const amount1In = a1 > 0n ? a1 : 0n;
        const amount0Out = a0 < 0n ? -a0 : 0n;
        const amount1Out = a1 < 0n ? -a1 : 0n;

        handleSwap(
          bot,
          chain,
          addr,
          tokens,
          event.transactionHash,
          ethers.BigNumber.from(amount0In),
          ethers.BigNumber.from(amount1In),
          ethers.BigNumber.from(amount0Out),
          ethers.BigNumber.from(amount1Out),
          recipient,
          event.blockNumber
        );
      } catch (e) {
        console.error("V4 Swap handler error:", e);
      }
    }
  );

  return {
    v2,
    v3,
    v4,
    token0: tokens.token0,
    token1: tokens.token1,
    targetToken: targetTokenLower
  };
}

// ────────────────── SWAP HANDLER ──────────────────

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

  // auto-refresh pools if only one / outdated
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

  // on-chain token decimals
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

  const rawTokenAmount = Number(
    ethers.utils.formatUnits(tokenOut, tokenDecimals)
  );

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

// ────────────────── HELPERS ──────────────────

export function getChainIdNumber(chain: ChainId): number | undefined {
  const map: Record<string, number> = {
    ethereum: 1,
    bsc: 56,
    base: 8453,
    monad: 131316155
  };
  const key = chain.toLowerCase();
  return map[key];
}

export async function getAllValidPairs(
  tokenAddress: string,
  chain: ChainId
): Promise<Array<{ address: string; liquidityUsd: number }>> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );
    const data: any = await res.json();

    if (!data.pairs || data.pairs.length === 0) return [];

    const pairs = data.pairs
      .filter((p: any) => {
        const targetChain = chain.toLowerCase();
        const apiChainId = String(p.chainId ?? "").toLowerCase();
        const apiChainName = String(p.chain ?? "").toLowerCase();
        const numericId = getChainIdNumber(chain);

        const isCorrectChain =
          apiChainId === targetChain ||
          apiChainName === targetChain ||
          (numericId !== undefined && apiChainId === String(numericId));

        const tokenAddrLower = tokenAddress.toLowerCase();
        const baseAddr = p.baseToken?.address?.toLowerCase();
        const quoteAddr = p.quoteToken?.address?.toLowerCase();

        const tokenMatch =
          baseAddr === tokenAddrLower || quoteAddr === tokenAddrLower;

        return isCorrectChain && tokenMatch;
      })
      .filter((p: any) => {
        const liq = p.liquidity?.usd ?? 0;
        return liq >= 10;
      })
      .map((p: any) => ({
        address: p.pairAddress,
        liquidityUsd: p.liquidity?.usd ?? 0
      }))
      .sort((a: any, b: any) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, 15);

    console.log(
      `[PAIRS] ${chain} ${tokenAddress} →`,
      pairs.map(
        (p: { address: string; liquidityUsd: number }) => ({
          addr: p.address,
          liq: p.liquidityUsd
        })
      )
    );

    return pairs;
  } catch (e: any) {
    console.error(
      `❌ getAllValidPairs error for token ${tokenAddress} on ${chain}: ${
        e?.message || e
      }`
    );
    return [];
  }
}

export async function getNativePrice(chain: ChainId): Promise<number> {
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

export async function getPreviousBalance(
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
export async function scanNewPoolsLoop(chain: ChainId) {
  console.log(`🚀 Starting hybrid new-pool watcher for ${chain}...`);

  const POLL_INTERVAL_MS = 30_000;

  while (true) {
    try {
      const pairs: SimplePairInfo[] = await getNewPairsHybrid(
        chain,
        5000,
        600
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
