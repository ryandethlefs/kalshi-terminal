import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clamp, fairYes, orderFee, realizedVol as realizedVolFrom } from "./lib/model.js";
import { buildRow, exitCall } from "./lib/board.js";
import { checkOrder, maxContractsAllowed, realizedPnl, haltCheck } from "./lib/risk.js";
import { score, verdict } from "./lib/shadow.js";
import { fairYesAveraged, averagingAdvantage, SETTLE_SAMPLES } from "./lib/crypto.js";
import { buildOrder, ORDER_PATH, TradeLog, settlePosition, closeEarly, calibration, filledCount, manage, rulesFor, cutPrice } from "./lib/execution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const E = cfg.engine;

const PORT = Number(process.env.PORT || 8787);
const KALSHI_BASE = process.env.KALSHI_BASE_URL || "https://external-api.kalshi.com";
const API_PREFIX = "/trade-api/v2";
const KEY_ID = process.env.KALSHI_KEY_ID || "";
const KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH || path.join(__dirname, "kalshi_private_key.pem");
// Pyth locked the Hermes price API behind an API key on 2026-08-26 and moved
// the host. The old hermes.pyth.network still answers feed metadata but returns
// 401 on any actual price, which is why a missing key looks like a working app
// with no prices in it.
const PYTH_HERMES = process.env.PYTH_HERMES_URL || "https://pyth.dourolabs.app/hermes";
const PYTH_BENCHMARKS = process.env.PYTH_BENCHMARKS_URL || "https://benchmarks.pyth.network";
const PYTH_API_KEY = process.env.PYTH_API_KEY || "";

const pythHeaders = () =>
  PYTH_API_KEY ? { Authorization: `Bearer ${PYTH_API_KEY}` } : {};

function pythError(status) {
  if (status === 401 || status === 403) {
    return PYTH_API_KEY
      ? `Pyth rejected your API key (${status}). Check PYTH_API_KEY in .env, and that the plan is active.`
      : `Pyth needs an API key (${status}). Set PYTH_API_KEY in .env. Sign up at Pyth Terminal.`;
  }
  return `Pyth request failed with ${status}`;
}

const DEMO = process.argv.includes("--demo") || process.env.DEMO === "1";

let privateKey = null;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH, "utf8"));
} catch (err) {
  if (!DEMO) console.error(`\n  Could not read your Kalshi private key at:\n    ${KEY_PATH}\n  ${err.message}\n  Set KALSHI_PRIVATE_KEY_PATH in your .env file.\n`);
}

const enabledSeries = cfg.series.filter((s) => s.enabled);
const enabledCrypto = (cfg.cryptoSeries || []).filter((s) => s.enabled);
const COINBASE = process.env.COINBASE_URL || "https://api.exchange.coinbase.com";

/* ------------------------------------------------------------------ */
/*  Kalshi request signing                                             */
/*  RSA-PSS over: timestampMs + METHOD + path (no query string)        */
/* ------------------------------------------------------------------ */

function authHeaders(method, signPath) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${signPath}`;
  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    "KALSHI-ACCESS-KEY": KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function kalshiGet(subPath, params = {}) {
  if (!privateKey || !KEY_ID) throw new Error("Kalshi credentials are not loaded");
  // Kalshi signs the path without its query string. If a caller passes one
  // inline, pull it out rather than signing it and failing with a 401 that
  // looks like a credentials problem.
  const [cleanPath, inlineQs] = subPath.split("?");
  const signPath = API_PREFIX + cleanPath;
  const merged = { ...Object.fromEntries(new URLSearchParams(inlineQs || "")), ...params };
  const qs = new URLSearchParams(merged).toString();
  const url = `${KALSHI_BASE}${signPath}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: authHeaders("GET", signPath) });
  const body = await res.text();
  if (!res.ok) throw new Error(`Kalshi ${res.status} on ${subPath}: ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Kalshi returned non-JSON on ${subPath}: ${body.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Math                                                               */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Pyth: live settlement price + realized volatility                  */
/* ------------------------------------------------------------------ */

const feedIds = new Map();   // series ticker -> pyth feed id
const priceBuf = new Map();  // series ticker -> [{t, price}]
const lastPrice = new Map(); // series ticker -> {price, t}

async function pythSearch(query) {
  const res = await fetch(`${PYTH_HERMES}/v2/price_feeds?query=${encodeURIComponent(query)}`, {
    headers: pythHeaders(),
  });
  if (!res.ok) throw new Error(pythError(res.status));
  return res.json();
}

async function resolveFeeds() {
  for (const s of enabledSeries) {
    if (feedIds.has(s.ticker)) continue;
    try {
      const hits = await pythSearch(s.pythQuery);
      if (!Array.isArray(hits) || hits.length === 0) {
        console.warn(`  Pyth: no feed found for ${s.label} (query "${s.pythQuery}")`);
        continue;
      }
      // Prefer an exact symbol match, otherwise take the first hit.
      const exact =
        hits.find(
          (h) => (h?.attributes?.symbol || "").toUpperCase().endsWith(s.pythQuery.toUpperCase())
        ) || hits[0];
      feedIds.set(s.ticker, exact.id);
      console.log(`  Pyth feed for ${s.label}: ${exact?.attributes?.symbol || "?"} (${exact.id.slice(0, 10)}...)`);
    } catch (err) {
      console.warn(`  Pyth feed lookup failed for ${s.label}: ${err.message}`);
    }
  }
}

async function pollPyth() {
  const ids = [...feedIds.values()];
  if (ids.length === 0) return;
  const qs = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${PYTH_HERMES}/v2/updates/price/latest?${qs}&parsed=true`, {
    headers: pythHeaders(),
  });
  if (!res.ok) throw new Error(pythError(res.status));
  const data = await res.json();
  const byId = new Map();
  for (const p of data.parsed || []) {
    const norm = p.id.startsWith("0x") ? p.id.slice(2) : p.id;
    byId.set(norm, Number(p.price.price) * Math.pow(10, p.price.expo));
  }
  pythError_ = null;
  const now = Date.now();
  for (const [ticker, id] of feedIds) {
    const norm = id.startsWith("0x") ? id.slice(2) : id;
    const px = byId.get(norm);
    if (!px || !isFinite(px) || px <= 0) continue;
    lastPrice.set(ticker, { price: px, t: now });
    const buf = priceBuf.get(ticker) || [];
    buf.push({ t: now, price: px });
    const cutoff = now - E.volWindowSec * 1000;
    while (buf.length && buf[0].t < cutoff) buf.shift();
    priceBuf.set(ticker, buf);
  }
}

/* ------------------------------------------------------------------ */
/*  Crypto: Coinbase spot, and the banked samples of the final minute  */
/* ------------------------------------------------------------------ */

const cryptoError = new Map();
// Samples already collected inside a window's final minute. Once banked they
// are fixed: that is the whole point of the averaged settlement model.
const bankedSamples = new Map();   // contract ticker -> number[]

async function coinbaseSpot(product) {
  const res = await fetch(`${COINBASE}/products/${product}/ticker`, {
    headers: { "User-Agent": "kalshi-15m-terminal" },
  });
  if (!res.ok) throw new Error(`Coinbase ${res.status} on ${product}`);
  const data = await res.json();
  const px = Number(data.price);
  if (!isFinite(px) || px <= 0) throw new Error(`Coinbase gave no price for ${product}`);
  return px;
}

async function pollCrypto() {
  const now = Date.now();
  for (const s of enabledCrypto) {
    try {
      const px = await coinbaseSpot(s.product);
      cryptoError.delete(s.ticker);
      lastPrice.set(s.ticker, { price: px, t: now });

      const buf = priceBuf.get(s.ticker) || [];
      buf.push({ t: now, price: px });
      while (buf.length && buf[0].t < now - E.volWindowSec * 1000) buf.shift();
      priceBuf.set(s.ticker, buf);

      // Inside the final minute, bank one sample per second.
      const m = marketState.get(s.ticker);
      if (m) {
        const tau = (new Date(m.close_time).getTime() - now) / 1000;
        if (tau > 0 && tau <= SETTLE_SAMPLES) {
          const bank = bankedSamples.get(m.ticker) || [];
          const wanted = Math.floor(SETTLE_SAMPLES - tau);
          if (bank.length <= wanted && bank.length < SETTLE_SAMPLES) {
            bank.push(px);
            bankedSamples.set(m.ticker, bank);
          }
        }
      }
    } catch (err) {
      cryptoError.set(s.ticker, err.message);
    }
  }
  // Forget windows long gone.
  if (bankedSamples.size > 200) bankedSamples.clear();
}

// Realized volatility, expressed per square-root-second.
function realizedVol(ticker) {
  const buf = priceBuf.get(ticker) || [];
  const spanSec = buf.length > 1 ? (buf[buf.length - 1].t - buf[0].t) / 1000 : 0;
  // A sample count is not enough. Thirty samples two seconds apart is sixty
  // seconds of history, which cannot measure how much a metal moves over
  // fifteen minutes. Too small a sigma makes the model overconfident and
  // manufactures edge that is not there, so gate on elapsed time as well.
  if (buf.length < E.minVolSamples || spanSec < E.minVolSpanSec) {
    return { sigma: null, samples: buf.length, spanSec };
  }
  return { sigma: realizedVolFrom(buf), samples: buf.length, spanSec };
}

// Historical 1-minute close at a past timestamp, used to recover a window's
// locked reference price when we started up mid-window.
async function pythCloseAt(ticker, unixSec) {
  const id = feedIds.get(ticker);
  if (!id) return null;
  const clean = id.startsWith("0x") ? id.slice(2) : id;
  const res = await fetch(`${PYTH_BENCHMARKS}/v1/updates/price/${unixSec}?ids=${clean}&parsed=true`, {
    headers: pythHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const p = (data.parsed || [])[0];
  if (!p) return null;
  return Number(p.price.price) * Math.pow(10, p.price.expo);
}

/* ------------------------------------------------------------------ */
/*  Kalshi polling                                                     */
/* ------------------------------------------------------------------ */

const marketState = new Map(); // series ticker -> market object
const refPrice = new Map();    // market ticker -> {k, source}
const seriesError = new Map();
let lastKalshiOk = 0;
let pythError_ = null;
let sampleMarket = null;
const shardBalance = new Map();
// Real positions, straight from the exchange. The bot's own list only knows
// about fills it recorded, and has disagreed with reality more than once.
let livePositions = [];
let positionsError = null;

async function pollPositions() {
  const found = [];
  for (const shard of [0, 2]) {
    try {
      const data = await kalshiGet("/portfolio/positions", { exchange_index: shard });
      for (const p of data.market_positions || []) {
        const contracts = Number(p.position);
        if (!contracts) continue;              // flat, nothing held
        found.push({
          ticker: p.ticker,
          shard,
          side: contracts > 0 ? "YES" : "NO",
          contracts: Math.abs(contracts),
          // market_exposure is what the position cost, in cents.
          exposureDollars: Number(p.market_exposure || 0) / 100,
          feesPaid: Number(p.fees_paid || 0) / 100,
          realizedPnl: Number(p.realized_pnl || 0) / 100,
          restingOrders: Number(p.resting_orders_count || 0),
        });
      }
      positionsError = null;
    } catch (err) {
      positionsError = err.message;
    }
  }
  livePositions = found;
}

/** Match each held position to its live market so we can price it. */
function positionsWithMarks(allRows) {
  const byTicker = new Map();
  for (const r of allRows) {
    if (r.market) byTicker.set(r.market.contractTicker, r);
  }
  return livePositions.map((p) => {
    const row = byTicker.get(p.ticker) || null;
    const m = row ? row.market : null;
    const bid = m ? (p.side === "YES" ? m.yesBid : m.noBid) : null;
    const entry = p.contracts ? p.exposureDollars / p.contracts : null;
    const markValue = bid != null ? bid * p.contracts : null;
    return {
      ...p,
      label: row ? row.label : null,
      secondsLeft: m ? m.secondsLeft : null,
      fair: m ? m.fair : null,
      bid,
      entry,
      markValue,
      // What it is worth now against what it cost. Not final until settlement.
      unrealised: markValue != null ? markValue - p.exposureDollars : null,
      pctMove: markValue != null && entry ? (bid - entry) / entry : null,
    };
  });
}   // exchange shard -> free dollars

async function pollBalance() {
  const data = await kalshiGet("/portfolio/balance");
  for (const row of data.balance_breakdown || []) {
    const v = Number(row.balance);
    if (isFinite(v)) shardBalance.set(Number(row.exchange_index), v);
  }
}

// Pull the reference price K out of whatever field Kalshi puts it in.
function extractReference(m, spot) {
  // The reference price for a window. Getting this wrong is the worst failure
  // mode in the whole system: a reference far from spot makes fair value pin at
  // near-certainty, which reads as a huge edge rather than as a broken input.
  //
  // This previously fell back to scanning the rules text for the first number,
  // which on a silver market picked the 17 out of "Silver on Sep 17, 2026" and
  // priced a $65 contract against a $17 strike.
  const numeric = (v) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  };

  // 1. The strike fields, which are the authoritative source.
  for (const [v, label] of [
    [m.floor_strike, "floor_strike"],
    [m.cap_strike, "cap_strike"],
    [m.custom_strike?.value, "custom_strike"],
  ]) {
    const n = numeric(v);
    if (n) return { k: n, source: label };
  }

  // 2. A price explicitly marked with a currency symbol, e.g. "Target Price: $65.144".
  //    Never a bare number, because dates and years are bare numbers.
  const text = `${m.yes_sub_title || ""} ${m.subtitle || ""} ${m.no_sub_title || ""}`;
  const dollar = text.match(/\$\s*([0-9][0-9,]*\.?[0-9]*)/);
  if (dollar) {
    const n = numeric(dollar[1].replace(/,/g, ""));
    if (n) return { k: n, source: "price in subtitle" };
  }

  return null;
}

// A reference must be in the same ballpark as the live price. Anything further
// than this apart is a parsing failure, not a real move, and must not be priced.
function referenceLooksSane(k, spot) {
  if (!spot) return true;            // nothing to check against yet
  const ratio = k / spot;
  return ratio > 0.8 && ratio < 1.25;
}

// Kalshi's market objects carry prices as `yes_bid_dollars` and friends, already
// in dollars. Older payloads used `yes_bid` in whole cents. The decision logic
// works in cents, so normalize here and keep both shapes working.
function normalizeMarket(m) {
  const cents = (dollars, legacy) => {
    const d = Number(dollars);
    if (isFinite(d)) return Math.round(d * 100);
    const c = Number(legacy);
    return isFinite(c) ? c : null;
  };
  return {
    ...m,
    yes_bid: cents(m.yes_bid_dollars, m.yes_bid),
    yes_ask: cents(m.yes_ask_dollars, m.yes_ask),
    no_bid: cents(m.no_bid_dollars, m.no_bid),
    no_ask: cents(m.no_ask_dollars, m.no_ask),
    volume: m.volume_fp ?? m.volume ?? null,
    open_interest: m.open_interest_fp ?? m.open_interest ?? null,
    exchange_index: m.exchange_index ?? 0,
  };
}

async function pollKalshi() {
  for (const s of [...enabledSeries, ...enabledCrypto]) {
    try {
      const data = await kalshiGet("/markets", {
        series_ticker: s.ticker,
        status: "open",
        limit: "20",
      });
      // A window whose close time has passed is finished, even if Kalshi is
      // still listing it. Without this the bot locks onto a dead window
      // forever, because it always picks the one closing soonest.
      const now = Date.now();
      const markets = (data.markets || [])
        .filter((m) => m.status === "active" || m.status === "open")
        .filter((m) => {
          const close = new Date(m.close_time).getTime();
          return isFinite(close) && close > now;
        })
        .map(normalizeMarket);
      if (!sampleMarket && markets.length) {
        sampleMarket = markets[0];
        try {
          fs.mkdirSync(path.join(__dirname, "debug"), { recursive: true });
          fs.writeFileSync(
            path.join(__dirname, "debug", "sample-market.json"),
            JSON.stringify(markets[0], null, 2)
          );
        } catch {}
      }
      // The live window is the one closing soonest.
      markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
      const live = markets[0] || null;
      marketState.set(s.ticker, live);
      seriesError.delete(s.ticker);
      lastKalshiOk = Date.now();

      if (live && !refPrice.has(live.ticker)) {
        const spotNow = lastPrice.get(s.ticker)?.price ?? null;
        const ext = extractReference(live, spotNow);
        if (ext && !referenceLooksSane(ext.k, spotNow)) {
          console.warn(
            `  ${s.label}: refusing reference ${ext.k} from ${ext.source}, ` +
            `live price is ${spotNow}. Not pricing this window.`
          );
        } else if (ext) {
          refPrice.set(live.ticker, ext);
        } else if (live.open_time) {
          const openSec = Math.floor(new Date(live.open_time).getTime() / 1000);
          const k = await pythCloseAt(s.ticker, openSec);
          const spotCheck = lastPrice.get(s.ticker)?.price ?? null;
          if (k && referenceLooksSane(k, spotCheck)) {
            refPrice.set(live.ticker, { k, source: "Pyth close at window open" });
          }
        }
      }
    } catch (err) {
      seriesError.set(s.ticker, err.message);
    }
  }
  // Forget closed windows so the traded-window map cannot grow without bound.
  {
    const live = new Set([...marketState.values()].filter(Boolean).map((m) => m.ticker));
    for (const t of tradedWindows.keys()) if (!live.has(t)) tradedWindows.delete(t);
  }

  // Drop reference prices for windows that have gone away.
  const liveTickers = new Set([...marketState.values()].filter(Boolean).map((m) => m.ticker));
  for (const t of refPrice.keys()) if (!liveTickers.has(t)) refPrice.delete(t);
}

/* ------------------------------------------------------------------ */
/*  Board assembly: gather state, hand it to the pure decision logic   */
/* ------------------------------------------------------------------ */

function shardFor(seriesTicker) {
  const m = marketState.get(seriesTicker);
  return m ? Number(m.exchange_index ?? 0) : 0;
}

const engineWithStrategy = { ...E, minFairToEnter: cfg.bot?.minFairToEnter, maxEntryCents: cfg.bot?.maxEntryCents };

const CRYPTO_TICKERS = new Set((cfg.cryptoSeries || []).map((s) => s.ticker));
const kindOf = (seriesTicker) => (CRYPTO_TICKERS.has(seriesTicker) ? "crypto" : "metals");

/**
 * Bot settings for one group, with its overrides applied.
 *
 * Metals and crypto behave differently enough that one number cannot serve
 * both: metals step down through a stop, crypto gaps past it.
 */
function botFor(kind) {
  return { ...B, ...(B[kind] || {}) };
}

/**
 * Risk limits for one group. Position slots and exposure are counted per
 * group, so crypto running around the clock cannot use up the slots gold and
 * silver need during their much shorter trading day.
 */
function limitsFor(seriesTicker) {
  const kind = kindOf(seriesTicker);
  const g = botFor(kind);
  const bal = shardBalance.get(shardFor(seriesTicker));
  return {
    ...limits,
    maxStakePerTrade: g.maxStakePerTrade ?? limits.maxStakePerTrade,
    maxOpenPositions: g.maxOpenPositions ?? limits.maxOpenPositions,
    maxTotalExposure: g.maxTotalExposure ?? limits.maxTotalExposure,
    shardBalance: bal ?? null,
  };
}

function cryptoRowFor(s, bankroll) {
  const market = marketState.get(s.ticker) || null;
  const ref = market ? refPrice.get(market.ticker) || null : null;
  const spot = lastPrice.get(s.ticker) || null;
  const vol = realizedVol(s.ticker);
  const banked = market ? bankedSamples.get(market.ticker) || [] : [];
  const g = botFor("crypto");
  const eng = {
    ...engineWithStrategy,
    minFairToEnter: g.minFairToEnter,
    maxEntryCents: g.maxEntryCents,
    maxSecondsLeft: g.maxSecondsLeft ?? E.maxSecondsLeft,
    minSecondsLeft: g.minSecondsLeft ?? E.minSecondsLeft,
    maxEdgeCentsBanked: g.maxEdgeCentsBanked,
    fairFn: fairYesAveraged,
    banked,
  };
  const row = buildRow(s, market, ref, spot, vol, eng, bankroll, Date.now(), cryptoError.get(s.ticker));
  if (row.market) {
    row.market.banked = banked.length;
    row.market.averagingAdvantage = vol.sigma
      ? averagingAdvantage(vol.sigma, row.market.secondsLeft)
      : null;
  }
  row.kind = "crypto";
  return row;
}

function rowFor(s, bankroll) {
  const market = marketState.get(s.ticker) || null;
  const ref = market ? refPrice.get(market.ticker) || null : null;
  const spot = lastPrice.get(s.ticker) || null;
  const vol = realizedVol(s.ticker);
  return buildRow(s, market, ref, spot, vol, engineWithStrategy, bankroll, Date.now(), seriesError.get(s.ticker));
}


/* ------------------------------------------------------------------ */
/*  The bot                                                            */
/*                                                                     */
/*  Nothing is sent unless the server was started with --live. Without */
/*  that flag it runs exactly the same logic and logs the order it     */
/*  would have placed, which is also how you check the payload shape   */
/*  before any money is involved.                                      */
/* ------------------------------------------------------------------ */

const LIVE = process.argv.includes("--live");
if (LIVE && DEMO) {
  console.error("\n  Refusing to start: --live and --demo together would place real\n" +
                "  orders against invented prices. Pick one.\n");
  process.exit(1);
}
const B = cfg.bot || {};
const limits = {
  dailyLossLimit: B.dailyLossLimit ?? 5,
  maxTotalLoss: B.maxTotalLoss ?? null,
  maxStakePerTrade: B.maxStakePerTrade ?? 2.5,
  maxOpenPositions: B.maxOpenPositions ?? 2,
  maxTotalExposure: B.maxTotalExposure ?? 5,
  maxDataAgeSec: B.maxDataAgeSec ?? 10,
};

const tradeLog = new TradeLog(path.join(__dirname, "log"));
// Windows already traded this session. Without this the bot closes a position
// and immediately re-enters the same window, paying the taker fee twice per
// round trip. Eighteen such orders in two minutes is roughly $1.80 of fees on
// a $5 daily stop, which empties the budget before any call is even judged.
const tradedWindows = new Map();   // contract ticker -> entries made
// A window that closes with a position still open used to be logged as an
// orphan and forgotten, so holding to settlement would have taught us nothing.
// These are kept and chased until Kalshi publishes the result.
const awaitingSettlement = [];

// Shadow scoring: a snapshot per window, resolved after it settles.
const shadowLog = new TradeLog(path.join(__dirname, "log", "shadow"));
const snapped = new Map();          // contract ticker -> snapshot taken
const shadowPending = [];           // snapshots waiting on a result
// Positions closed before settlement, kept under observation so we learn what
// the window eventually did. Without this the one number that decides whether
// a stop is worth having, how often a stopped-out position would have come
// good, can never be known.
const followUps = [];

async function resolveFollowUps() {
  for (const f of [...followUps]) {
    try {
      const data = await kalshiGet(`/markets/${f.ticker}`);
      const m = data.market || data;
      const result = (m?.result || "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;
      const wouldHaveWon = result === f.side.toLowerCase();
      tradeLog.append({
        kind: "follow_up",
        ticker: f.ticker, label: f.label, side: f.side, how: f.how,
        entry: f.entry, exit: f.exit, contracts: f.contracts,
        realisedPnl: f.pnl,
        result,
        wouldHaveWon,
        // What holding instead would have paid, ignoring the exit fee saved.
        holdPnl: wouldHaveWon ? f.contracts * (1 - f.entry) : -f.contracts * f.entry,
        live: f.live === true,
      });
      followUps.splice(followUps.indexOf(f), 1);
    } catch {
      // try again next pass
    }
  }
}

function takeSnapshot(row) {
  const m = row.market;
  if (!m || m.fair == null || m.secondsLeft == null) return;
  const at = E.shadowSnapshotAtSec ?? 300;
  // One snapshot per window, at roughly the same point each time so the
  // numbers are comparable across windows.
  if (m.secondsLeft > at || snapped.has(m.contractTicker)) return;
  const snap = {
    ticker: m.contractTicker,
    label: row.label,
    fair: m.fair,
    marketMid: m.mid,
    yesBid: m.yesBid,
    yesAsk: m.yesAsk,
    reference: m.reference,
    spot: m.spot,
    secondsLeft: Math.round(m.secondsLeft),
  };
  snapped.set(m.contractTicker, snap);
  shadowPending.push(snap);
}

async function resolveShadow() {
  for (const snap of [...shadowPending]) {
    try {
      const data = await kalshiGet(`/markets/${snap.ticker}`);
      const m = data.market || data;
      const result = (m?.result || "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;
      shadowLog.append({ kind: "scored", ...snap, result });
      shadowPending.splice(shadowPending.indexOf(snap), 1);
    } catch {
      // try again next pass
    }
  }
  // Forget snapshots for windows long gone so the map cannot grow forever.
  if (snapped.size > 500) snapped.clear();
}

function shadowReport() {
  const snaps = shadowLog.all().filter((r) => r.kind === "scored");
  const s = score(snaps);
  return { pending: shadowPending.length, ...(s ? { ...s, verdict: verdict(s) } : { windows: 0 }) };
}
const botState = {
  // armed = the bot acts on signals. live = those actions leave this machine.
  // Dry run is armed by default so it rehearses the whole path harmlessly.
  armed: true,
  killed: false,
  live: LIVE,
  positions: [],       // open, in-memory; the log is the durable record
  lastError: null,
  lastAction: null,
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const realizedToday = () => realizedPnl(tradeLog.closed(), startOfToday());
const realizedEver = () => realizedPnl(tradeLog.closed(), 0);

/**
 * Risk state as seen by one group.
 *
 * `kind` matters: open positions and exposure are counted only within the
 * group, so gold and silver keep their own slot while crypto trades overnight.
 */
function riskState(dataAgeSec, kind) {
  return {
    armed: botState.armed,
    killed: botState.killed,
    realizedToday: realizedToday(),
    realizedEver: realizedEver(),
    openPositions: kind
      ? botState.positions.filter((p) => (p.kind || "metals") === kind)
      : botState.positions,
    dataAgeSec,
  };
}

/** DELETE, used to cancel a resting stop when it is no longer wanted. */
async function kalshiDelete(subPath) {
  if (!privateKey || !KEY_ID) throw new Error("Kalshi credentials are not loaded");
  const signPath = API_PREFIX + subPath.split("?")[0];
  const res = await fetch(`${KALSHI_BASE}${signPath}`, {
    method: "DELETE",
    headers: authHeaders("DELETE", signPath),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function kalshiPost(subPath, body) {
  const signPath = API_PREFIX + subPath;
  const res = await fetch(`${KALSHI_BASE}${signPath}`, {
    method: "POST",
    headers: authHeaders("POST", signPath),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, body: parsed ?? text };
}

async function sendOrder(payload, note) {
  if (!botState.live) {
    tradeLog.append({ kind: "dry_run", note, payload });
    console.log(`  [dry run] would send: ${JSON.stringify(payload)}`);
    return { ok: true, dryRun: true, body: null };
  }
  const res = await kalshiPost(ORDER_PATH, payload);
  tradeLog.append({ kind: "order_response", note, payload, status: res.status, response: res.body });
  if (!res.ok) {
    botState.lastError = `Order rejected (${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`;
    console.warn(`  ${botState.lastError}`);
  }
  return res;
}

async function resolveSettlements() {
  for (const pos of [...awaitingSettlement]) {
    try {
      const data = await kalshiGet(`/markets/${pos.ticker}`);
      const m = data.market || data;
      const result = (m?.result || "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;   // not published yet
      const rec = settlePosition(pos, m);
      if (rec) {
        tradeLog.append({ ...rec, live: pos.live === true });
        botState.lastAction =
          `Settled ${pos.label} ${pos.side}: ${rec.won ? "won" : "lost"} $${rec.pnl.toFixed(2)}`;
      }
      awaitingSettlement.splice(awaitingSettlement.indexOf(pos), 1);
    } catch (err) {
      // Leave it queued and try again next pass.
    }
  }
}

/**
 * Park a sell order on the book at the stop level, immediately on entry.
 *
 * This is the difference between a stop that works and one that does not. An
 * immediate-or-cancel stop asks "is anyone buying at my price this instant",
 * and during the fast move that triggered it the answer is no. It cancels,
 * retries against a worse price, and repeats all the way down: a 55% stop
 * produced a 98% loss that way on 18 Sep. An order resting on the book is
 * already there when the price trades through it.
 */
async function placeRestingStop(pos, row) {
  if (!pos || !botState.live) return;
  const g = botFor(kindOf(pos.seriesTicker || ""));
  const pct = g.stopLossPercent;
  if (pct == null) return;

  const stopCents = Math.max(1, Math.round(pos.entry * 100 * (1 - pct / 100)));
  const payload = buildOrder({
    ticker: pos.ticker,
    side: pos.side,
    limitCents: stopCents,
    contracts: pos.contracts,
    action: "sell",
    exchangeIndex: pos.exchangeIndex ?? 0,
    resting: true,
  });
  const res = await kalshiPost(ORDER_PATH, payload);
  tradeLog.append({
    kind: "resting_stop",
    ticker: pos.ticker, label: pos.label, side: pos.side,
    stopCents, contracts: pos.contracts,
    status: res.status, response: res.body,
  });
  if (res.ok) {
    let body = {};
    try { body = typeof res.body === "string" ? JSON.parse(res.body) : res.body; } catch {}
    pos.restingStopId = body.order_id || body?.order?.order_id || null;
    pos.stopCents = stopCents;
    botState.lastAction = `Stop resting at ${stopCents}c on ${pos.label}`;
  } else {
    // A stop that never got placed must not be mistaken for protection.
    pos.restingStopFailed = res.body;
    botState.lastError = `Could not rest a stop on ${pos.label}: ${String(res.body).slice(0, 120)}`;
  }
}

/** Pull the resting stop once the position is gone for any other reason. */
async function cancelRestingStop(pos) {
  if (!pos || !pos.restingStopId) return;
  const res = await kalshiDelete(`/portfolio/orders/${pos.restingStopId}`);
  tradeLog.append({
    kind: "cancel_stop", ticker: pos.ticker,
    orderId: pos.restingStopId, status: res.status, response: String(res.body).slice(0, 200),
  });
  pos.restingStopId = null;
}

async function botTick(rows) {
  const halt = haltCheck({ killed: botState.killed, realizedToday: realizedToday(), realizedEver: realizedEver() }, limits);
  if (halt.halted) {
    botState.lastAction = halt.reason;
    return;
  }

  const byTicker = new Map(rows.map((r) => [r.ticker, r]));

  // 1. Settle or close anything already open, before opening anything new.
  for (const pos of [...botState.positions]) {
    const row = byTicker.get(pos.series);
    if (!row) continue;
    const market = marketState.get(pos.series);

    if (market && market.ticker === pos.ticker && (market.result || "").length) {
      const rec = settlePosition(pos, market);
      if (rec) {
        tradeLog.append(rec);
        botState.positions = botState.positions.filter((p) => p !== pos);
        botState.lastAction = `Settled ${pos.label} ${pos.side}: ${rec.won ? "won" : "lost"} $${rec.pnl.toFixed(2)}`;
        continue;
      }
    }

    // The window closed while we held it. Queue it for settlement rather than
    // dropping it, otherwise the outcome, which is the only real test of the
    // model, is lost.
    if (!market || market.ticker !== pos.ticker) {
      await cancelRestingStop(pos);
      awaitingSettlement.push(pos);
      botState.positions = botState.positions.filter((p) => p !== pos);
      tradeLog.append({ kind: "awaiting_settlement", ticker: pos.ticker, label: pos.label });
      continue;
    }

    if (B.holdToSettlement === true) continue;

    // Price-based management: take profit, cut, or leave it. Note that on the
    // 17 Sep session early exits reduced losses rather than causing them, so
    // the stop is the part of this doing the real work.
    const x = manage(pos, row.market, rulesFor(pos, botFor(kindOf(pos.seriesTicker || ""))));
    if ((x.call === "TAKE PROFIT" || x.call === "CUT") && row.market) {
      const bid = pos.side === "YES" ? row.market.yesBid : row.market.noBid;
      // A cut crosses the spread and widens on each failure. A take profit can
      // afford to be patient; a stop cannot.
      pos.cutAttempts = pos.cutAttempts || 0;
      const limitCents =
        x.call === "CUT"
          ? cutPrice(bid * 100, pos.cutAttempts, B)
          : Math.round(bid * 100);
      const payload = buildOrder({
        ticker: pos.ticker, side: pos.side,
        limitCents, contracts: pos.contracts, action: "sell",
        exchangeIndex: market.exchange_index ?? 0,
      });
      const res = await sendOrder(payload, "exit");
      const sold = res.dryRun ? pos.contracts : filledCount(res.body);
      if (res.ok && sold > 0) {
        // A partial fill leaves the rest of the position open.
        const closedPart = { ...pos, contracts: sold };
        const rec = closeEarly(closedPart, limitCents / 100, orderFee(limitCents / 100, sold));
        tradeLog.append({ ...rec, live: botState.live });
        // Keep watching this window so we find out whether giving up was right.
        followUps.push({ ...rec, how: x.call, live: botState.live });
        if (sold >= pos.contracts) {
          botState.positions = botState.positions.filter((p) => p !== pos);
        } else {
          pos.contracts -= sold;
        }
        await cancelRestingStop(pos);
        botState.lastAction = `${x.call}: ${sold} ${pos.label} at ${x.bidCents.toFixed(0)}c for $${rec.pnl.toFixed(2)}`;
      } else if (res.ok) {
        if (x.call === "CUT") pos.cutAttempts += 1;
        tradeLog.append({
          kind: "no_fill", note: "exit", ticker: pos.ticker,
          attempt: pos.cutAttempts, offeredCents: limitCents, response: res.body,
        });
        botState.lastAction =
          x.call === "CUT"
            ? `${pos.label}: cut did not fill at ${limitCents}c, widening`
            : `${pos.label}: exit order did not fill`;
      }
    }
  }

  // 2. Look for something to open.
  for (const row of rows) {
    const a = row.action;
    if (!a.call.startsWith("BUY") || !row.market) continue;

    const state = riskState(row.market.spotAgeSec, kindOf(row.ticker));
    const lim = limitsFor(row.ticker);
    const size = maxContractsAllowed(a.limitCents, state, lim);
    if (size < 1) {
      const bal = lim.shardBalance;
      botState.lastAction =
        bal != null && bal < a.limitCents / 100
          ? `${row.label}: only $${bal.toFixed(2)} on shard ${shardFor(row.ticker)}, needs ${a.limitCents}c a contract`
          : `${row.label}: signal but no room to size it`;
      continue;
    }

    const liveMarket = marketState.get(row.ticker);
    // Re-entering a window it just left is only worth it when fair value is
    // accurate: each round trip pays the taker fee twice. Both legs already
    // require edge net of fees, so churn is not automatically losing, but a
    // noisy fair value turns it into a fee pump. 0 means no limit.
    const entriesMade = tradedWindows.get(row.market.contractTicker) || 0;
    const maxEntries = B.maxEntriesPerWindow ?? 0;
    if (maxEntries > 0 && entriesMade >= maxEntries) {
      botState.lastAction = `${row.label}: already traded this window, waiting for the next one`;
      continue;
    }

    const order = {
      ticker: row.market.contractTicker, side: a.side,
      limitCents: a.limitCents, contracts: size,
      exchangeIndex: liveMarket?.exchange_index ?? 0,
    };
    const verdict = checkOrder(order, state, lim);

    // Every signal is recorded whether or not it is acted on. Over time this
    // file, not the balance, is what says if the strategy works.
    tradeLog.append({
      kind: "signal", ticker: order.ticker, label: row.label, side: a.side,
      limitCents: a.limitCents, wanted: a.contracts, sized: size,
      edgeCents: a.evCents, fair: row.market.fair,
      allowed: verdict.allowed, blockedBy: verdict.reason,
    });

    if (!verdict.allowed) {
      botState.lastAction = `${row.label}: ${verdict.reason}`;
      continue;
    }

    const res = await sendOrder(buildOrder(order), "entry");
    // An accepted order is not a filled order. Only count what actually filled.
    const filled = res.dryRun ? size : filledCount(res.body);
    if (res.ok && filled > 0) {
      botState.positions.push({
        ticker: order.ticker, series: row.ticker, label: row.label,
        side: a.side, contracts: filled, entry: a.limitCents / 100, live: botState.live,
        seriesTicker: row.ticker, kind: kindOf(row.ticker),
        exchangeIndex: market.exchange_index ?? 0,
        entryFee: verdict.fee, predictedFair: a.side === "YES" ? row.market.fair : 1 - row.market.fair,
        openedAt: Date.now(),
      });
      tradedWindows.set(order.ticker, entriesMade + 1);
      tradeLog.append({ kind: "open", ...order, contracts: filled, requested: size, fee: verdict.fee, fair: row.market.fair });
      botState.lastAction = `Bought ${filled} ${row.label} ${a.side} at ${a.limitCents}c`;
      await placeRestingStop(botState.positions[botState.positions.length - 1], row);
    } else if (res.ok) {
      // Accepted but nothing filled: the price moved away or the book was thin.
      tradeLog.append({ kind: "no_fill", ...order, response: res.body });
      botState.lastAction = `${row.label}: order accepted but nothing filled at ${a.limitCents}c`;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/board", (req, res) => {
  const bankroll = Number(req.query.bankroll) || 1000;
  let positions = [];
  try {
    positions = req.query.positions ? JSON.parse(req.query.positions) : [];
  } catch {}

  const rows = enabledSeries.map((s) => rowFor(s, bankroll));
  const cryptoRows = enabledCrypto.map((s) => cryptoRowFor(s, bankroll));
  for (const row of [...rows, ...cryptoRows]) takeSnapshot(row);
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));

  const posOut = positions.map((pos) => {
    const row = byTicker.get(pos.ticker);
    return {
      ...pos,
      label: row?.label || pos.ticker,
      exit: row ? exitCall(row, pos, E) : { call: "HOLD", reason: "Series not on the board" },
    };
  });

  const closed = tradeLog.closed();
  res.json({
    bot: {
      live: botState.live,
      armed: botState.armed,
      killed: botState.killed,
      limits,
      shardBalances: Object.fromEntries(shardBalance),
      realizedToday: realizedToday(),
      realizedEver: realizedEver(),
      openPositions: botState.positions,
      openByKind: {
        metals: botState.positions.filter((p) => (p.kind || "metals") === "metals").length,
        crypto: botState.positions.filter((p) => p.kind === "crypto").length,
      },
      lastAction: botState.lastAction,
      lastError: botState.lastError,
      strategy: {
        minFairToEnter: B.minFairToEnter,
        takeProfitCents: B.takeProfitCents,
        stopLossCents: B.stopLossCents,
      },
      awaitingSettlement: awaitingSettlement.length,
      tradesToday: closed.filter((t) => t.closedAt >= startOfToday()).length,
      calibration: calibration(closed),
      shadow: shadowReport(),
    },
    serverTime: Date.now(),
    kalshiLastOk: lastKalshiOk,
    credentialsLoaded: Boolean(privateKey && KEY_ID),
    demo: DEMO,
    pythError: pythError_,
    engine: E,
    rows,
    cryptoRows,
    positions: posOut,
    held: positionsWithMarks([...rows, ...cryptoRows]),
    positionsError,
  });
});


app.post("/api/bot/kill", (req, res) => {
  botState.killed = true;
  botState.armed = false;
  tradeLog.append({ kind: "kill_switch" });
  res.json({ killed: true });
});

app.post("/api/bot/arm", (req, res) => {
  botState.killed = false;
  botState.armed = true;
  tradeLog.append({ kind: "armed" });
  res.json({ armed: true });
});

app.post("/api/bot/disarm", (req, res) => {
  botState.armed = false;
  tradeLog.append({ kind: "disarmed" });
  res.json({ armed: false });
});

// Sends one contract at 1 cent, which will not fill, purely to see the real
// request and response shape. Run this once before arming anything.
app.post("/api/probe-order", async (req, res) => {
  const series = enabledSeries[0];
  const m = series ? marketState.get(series.ticker) : null;
  if (!m) return res.status(400).json({ error: "No open market to probe against" });

  // One order per book side, both priced so far from the market that they
  // cannot fill. What matters is whether Kalshi accepts the shape, and that
  // buying NO really does land on the ask side.
  const probes = [
    { note: "buy YES at 1c", order: { ticker: m.ticker, side: "YES", limitCents: 1, contracts: 1, exchangeIndex: m.exchange_index ?? 0 } },
    { note: "buy NO at 1c", order: { ticker: m.ticker, side: "NO", limitCents: 1, contracts: 1, exchangeIndex: m.exchange_index ?? 0 } },
  ];

  const out = [];
  for (const p of probes) {
    const payload = buildOrder(p.order);
    const result = await kalshiPost(ORDER_PATH, payload);
    tradeLog.append({ kind: "probe", note: p.note, payload, status: result.status, response: result.body });
    out.push({
      intent: p.note,
      bookSide: payload.side,
      bookPrice: payload.price,
      exchangeIndex: payload.exchange_index,
      status: result.status,
      accepted: result.ok,
      response: result.body,
    });
  }
  res.json({ path: API_PREFIX + ORDER_PATH, probes: out });
});

// Balance, broken down per exchange shard. Collateral does not move between
// shards on its own: Kalshi's checks run inside each matching engine, so funds
// must be preallocated on the shard you intend to trade.
app.get("/api/balance", async (req, res) => {
  try {
    const data = await kalshiGet("/portfolio/balance");
    const shards = [];
    for (const s2 of enabledSeries) {
      const m = marketState.get(s2.ticker);
      if (m) shards.push({ series: s2.label, exchangeIndex: m.exchange_index ?? 0 });
    }
    res.json({ balance: data, marketsTradeOn: shards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Collateral does not follow orders across shards. The fix is a standing
// target allocation: Kalshi rebalances toward it every ten seconds. This is
// not a one-off transfer, it is a policy that stays in force.
app.get("/api/allocation", async (req, res) => {
  try {
    res.json(await kalshiGet("/portfolio/target_balance_allocation"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct transfer between shards within the same account. The field names are
// source_exchange_shard / destination_exchange_shard, and amount is in
// CENTICENTS: one cent is 100, so $25 is 250000. Using the wrong field names
// leaves both shards at 0, which Kalshi rejects as a same-account transfer.
app.post("/api/transfer", async (req, res) => {
  const dollars = Number(req.query.dollars);
  const to = Number(req.query.to ?? 2);
  const from = Number(req.query.from ?? 0);
  if (!isFinite(dollars) || dollars <= 0 || !isFinite(to) || from === to) {
    return res.status(400).json({ error: "Pass ?dollars=25&to=2 (from defaults to 0)" });
  }
  const body = {
    source: "event_contract",
    destination: "event_contract",
    amount: Math.round(dollars * 100 * 100), // dollars -> cents -> centicents
    source_exchange_shard: from,
    destination_exchange_shard: to,
    source_subaccount: 0,
    destination_subaccount: 0,
  };
  const r = await kalshiPost("/portfolio/intra_exchange_instance_transfer", body);
  tradeLog.append({ kind: "transfer", body, status: r.status, response: r.body });
  res.json({ sent: body, status: r.status, ok: r.ok, response: r.body });
});

app.post("/api/allocate", async (req, res) => {
  const to = Number(req.query.to ?? 2);
  const percent = Number(req.query.percent ?? 50);
  if (!isFinite(to) || !isFinite(percent) || percent < 0 || percent > 100) {
    return res.status(400).json({ error: "Pass ?to=2&percent=50" });
  }
  const allocations =
    to === 0
      ? [{ exchange_index: 0, percent: 100 }]
      : [
          { exchange_index: 0, percent: 100 - percent },
          { exchange_index: to, percent },
        ];
  const r = await kalshiPost("/portfolio/target_balance_allocation", { allocations });
  tradeLog.append({ kind: "allocation", allocations, status: r.status, response: r.body });
  res.json({ sent: { allocations }, status: r.status, ok: r.ok, response: r.body });
});

// Was closing early the right call? Compares what each early exit actually
// realised against what holding to settlement would have paid.
// Reconcile the bot's ledger against the exchange.
//
// The bot's P&L only counts closes it recorded. Settlements it missed, orders
// it lost track of, and anything still queued are invisible to it. The
// exchange knows the truth, so the only honest number is the difference
// between what Kalshi says your balance is and what it was when you started.
app.get("/api/reconcile", async (req, res) => {
  try {
    const bal = await kalshiGet("/portfolio/balance");
    const shard2 = (bal.balance_breakdown || []).find((b) => Number(b.exchange_index) === 2);
    const closed = tradeLog.closed();
    const ledger = closed.reduce((s2, t) => s2 + t.pnl, 0);

    let positions = null;
    try {
      const p = await kalshiGet("/portfolio/positions");
      positions = (p.market_positions || []).filter((x) => Number(x.position) !== 0).length;
    } catch {}

    res.json({
      exchange: {
        totalDollars: bal.balance_dollars ?? null,
        shard2Dollars: shard2 ? shard2.balance : null,
        openPositionsOnExchange: positions,
      },
      botLedger: {
        closesRecorded: closed.length,
        sumOfThose: Number(ledger.toFixed(2)),
        openPositionsTracked: botState.positions.length,
        awaitingSettlement: awaitingSettlement.length,
      },
      note:
        "The exchange figure is the truth. If the ledger disagrees, the bot " +
        "missed closes, not the other way round. Compare the exchange total " +
        "against what you deposited to get your real profit or loss.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/exits", (req, res) => {
  const ups = tradeLog.all().filter((r) => r.kind === "follow_up" && r.live === true);
  if (ups.length === 0) {
    return res.json({ followed: 0, note: "No closed-early positions have settled yet." });
  }
  const byHow = {};
  for (const u of ups) {
    const k = u.how || "SOLD";
    const b = (byHow[k] = byHow[k] || { n: 0, recovered: 0, realised: 0, ifHeld: 0 });
    b.n += 1;
    b.recovered += u.wouldHaveWon ? 1 : 0;
    b.realised += u.realisedPnl;
    b.ifHeld += u.holdPnl;
  }
  res.json({
    followed: ups.length,
    byHow: Object.entries(byHow).map(([how, b]) => ({
      how,
      n: b.n,
      wouldHaveRecovered: b.recovered,
      recoveryRate: b.recovered / b.n,
      actuallyMade: Number(b.realised.toFixed(2)),
      holdingWouldHaveMade: Number(b.ifHeld.toFixed(2)),
      exitingCostYou: Number((b.ifHeld - b.realised).toFixed(2)),
    })),
  });
});

app.get("/api/calibration", (req, res) => res.json(shadowReport()));

app.get("/api/log", (req, res) => res.json(tradeLog.all().slice(-200)));

// Verify a resting stop can actually be placed and cancelled on this account.
// Sends a sell order so far from the market that it cannot fill, reads back
// whether it rested, then cancels it.
app.post("/api/probe-stop", async (req, res) => {
  const out = { steps: [] };
  try {
    const anyRow = [...enabledCrypto, ...enabledSeries]
      .map((s2) => marketState.get(s2.ticker))
      .find(Boolean);
    if (!anyRow) return res.status(400).json({ error: "No open window to probe against." });

    const payload = buildOrder({
      ticker: anyRow.ticker, side: "YES", limitCents: 1, contracts: 1,
      action: "sell", exchangeIndex: anyRow.exchange_index ?? 0, resting: true,
    });
    out.steps.push({ step: "payload", tif: payload.time_in_force ?? "(none, rests)", payload });

    const placed = await kalshiPost(ORDER_PATH, payload);
    out.steps.push({ step: "place", status: placed.status, body: String(placed.body).slice(0, 400) });

    let id = null;
    try {
      const b = typeof placed.body === "string" ? JSON.parse(placed.body) : placed.body;
      id = b.order_id || b?.order?.order_id || null;
    } catch {}
    out.orderId = id;

    if (id) {
      const cancelled = await kalshiDelete(`/portfolio/orders/${id}`);
      out.steps.push({ step: "cancel", status: cancelled.status, body: String(cancelled.body).slice(0, 400) });
    } else {
      out.steps.push({ step: "cancel", skipped: "no order_id came back, so nothing to cancel" });
    }
    res.json(out);
  } catch (err) {
    out.error = err.message;
    res.status(500).json(out);
  }
});

app.get("/api/coinbase-check", async (req, res) => {
  const product = String(req.query.product || "BTC-USD");
  try {
    res.json({ product, price: await coinbaseSpot(product) });
  } catch (err) {
    res.status(500).json({ product, error: err.message });
  }
});

app.get("/api/pyth-search", async (req, res) => {
  try {
    const hits = await pythSearch(String(req.query.q || ""));
    res.json(
      (hits || []).slice(0, 40).map((h) => ({
        id: h.id,
        symbol: h?.attributes?.symbol,
        assetType: h?.attributes?.asset_type,
        description: h?.attributes?.description,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/debug", (req, res) => {
  res.json({
    kalshiBase: KALSHI_BASE,
    keyIdLoaded: Boolean(KEY_ID),
    privateKeyLoaded: Boolean(privateKey),
    feeds: Object.fromEntries(feedIds),
    errors: Object.fromEntries(seriesError),
    references: Object.fromEntries(refPrice),
    sampleMarket,
  });
});

/* ------------------------------------------------------------------ */
/*  Loops                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Demo mode: fake windows so you can see the desk on a weekend.      */
/*  Set DEMO=1. Never use these numbers to trade.                      */
/* ------------------------------------------------------------------ */

const demoBase = { KXGOLD15M: 4241.3, KXSILVER15M: 62.18, KXCOPPER15M: 5.12, KXPLATINUM15M: 1483.5, KXPALLADIUM15M: 1394.2, KXWTI15M: 71.44 };

function demoTick() {
  const now = Date.now();
  // Windows start on the quarter hour and run 15 minutes.
  const windowMs = 15 * 60 * 1000;
  const openMs = Math.floor(now / windowMs) * windowMs;
  const closeMs = openMs + windowMs;

  for (const s of enabledSeries) {
    const base = demoBase[s.ticker] || 100;
    const drift = Math.sin(now / 90000 + base) * base * 0.0006;
    const jitter = (Math.random() - 0.5) * base * 0.00004;
    const px = base + drift + jitter;

    lastPrice.set(s.ticker, { price: px, t: now });
    const buf = priceBuf.get(s.ticker) || [];
    buf.push({ t: now, price: px });
    while (buf.length && buf[0].t < now - E.volWindowSec * 1000) buf.shift();
    priceBuf.set(s.ticker, buf);

    const contractTicker = `${s.ticker}-DEMO${new Date(openMs).toISOString().slice(11, 16).replace(":", "")}`;
    const ref = base + Math.sin(openMs / 90000 + base) * base * 0.0006;
    refPrice.set(contractTicker, { k: ref, source: "demo" });

    const sigma = realizedVolFrom(buf) || 0.00002;
    const tau = Math.max(1, (closeMs - now) / 1000);
    const p = fairYes(px, ref, sigma, tau) ?? 0.5;
    const mid = Math.round(clamp(p + (Math.random() - 0.5) * 0.06, 0.02, 0.98) * 100);

    marketState.set(s.ticker, {
      ticker: contractTicker,
      status: "active",
      open_time: new Date(openMs).toISOString(),
      close_time: new Date(closeMs).toISOString(),
      yes_bid: clamp(mid - 2, 1, 98),
      yes_ask: clamp(mid + 2, 2, 99),
      no_bid: clamp(100 - mid - 2, 1, 98),
      no_ask: clamp(100 - mid + 2, 2, 99),
      volume: Math.floor(2000 + Math.random() * 6000),
      open_interest: Math.floor(1000 + Math.random() * 4000),
    });
  }
  lastKalshiOk = now;
}

async function loop(fn, ms, name) {
  for (;;) {
    try {
      await fn();
    } catch (err) {
      if (name === "Pyth") pythError_ = err.message;
      console.warn(`  ${name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, ms));
  }
}

app.listen(PORT, async () => {
  console.log(`\n  Kalshi 15-minute terminal running at http://localhost:${PORT}`);
  if (enabledSeries.length) {
    console.log(`  Metals via Pyth: ${enabledSeries.map((s) => s.label).join(", ")}\n`);
  } else {
    console.log("  Metals: off (no Pyth key needed)\n");
  }
  // The bot runs in every mode. Without --live it only ever logs the order it
  // would have sent, which is how you rehearse it safely.
  const runBot = () =>
    loop(async () => {
      const rows = [
        ...enabledSeries.map((s2) => rowFor(s2, B.bankroll ?? 1000)),
        ...enabledCrypto.map((s2) => cryptoRowFor(s2, B.bankroll ?? 1000)),
      ];
      await botTick(rows);
    }, 2000, "Bot");

  loop(resolveSettlements, 20000, "Settle");
  loop(resolveShadow, 30000, "Shadow");
  loop(resolveFollowUps, 30000, "FollowUp");
  if (enabledCrypto.length) {
    console.log(`  Crypto via Coinbase: ${enabledCrypto.map((s2) => s2.label).join(", ")}\n`);
  }
  if (DEMO) {
    console.log("  DEMO MODE: prices and books below are invented. Do not trade off them.\n");
    loop(async () => demoTick(), 250, "demo");
    runBot();
    return;
  }
  if (!PYTH_API_KEY) {
    console.warn(
      "\n  No PYTH_API_KEY set. Kalshi will work, but there will be no live\n" +
      "  price, so no fair value and no trade calls. Get a key at Pyth Terminal\n" +
      "  and add PYTH_API_KEY to your .env file.\n"
    );
  }
  await resolveFeeds();
  // Pyth is only needed for metals. With none enabled, do not poll it at all:
  // an expired or rejected key would otherwise fill the log with 403s and put
  // a feed error on screen for a feed nothing is using.
  if (enabledSeries.length) loop(pollPyth, E.pythPollMs, "Pyth");
  if (enabledCrypto.length) loop(pollCrypto, 1000, "Coinbase");
  loop(pollKalshi, E.kalshiPollMs, "Kalshi");
  loop(pollBalance, 15000, "Balance");
  loop(pollPositions, 2000, "Positions");
  runBot();
  setInterval(resolveFeeds, 5 * 60 * 1000);
});
