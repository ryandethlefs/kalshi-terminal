// Execution. Builds orders, records every one, and tracks them to settlement.
//
// One deliberate constraint: this module never decides *whether* to trade.
// That is the risk engine's job. This module only turns an approved decision
// into a request and remembers what happened.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Build the order payload for Kalshi.
 *
 * The market feed now returns prices as `yes_bid_dollars`, so the order API may
 * expect dollars too. Both shapes are sent; Kalshi ignores fields it does not
 * use, and whichever one is live will be honoured. The probe endpoint in
 * server.js exists to confirm which, against a real response.
 */
/**
 * Translate a decision into a Kalshi V2 order.
 *
 * V2 dropped the yes/no order shape for a single book quoted in bid/ask, and
 * takes count and price as fixed-point strings rather than numbers. A binary
 * market has one book, the YES book, so:
 *
 *   buy YES  at P  ->  bid at P
 *   sell YES at P  ->  ask at P
 *   buy NO   at P  ->  ask at (1 - P)     because buying NO is selling YES
 *   sell NO  at P  ->  bid at (1 - P)
 *
 * exchangeIndex must come from the market being traded, never assumed.
 *
 * Getting this mapping wrong places the opposite of the intended trade, which
 * is why bookSide and bookPrice are returned for logging and asserted in tests.
 */
export function buildOrder({ ticker, side, limitCents, contracts, action = "buy", exchangeIndex = 0 }) {
  const isYes = side.toUpperCase() === "YES";
  const isBuy = action === "buy";

  // Buying YES and selling NO both lift the bid side of the YES book.
  const bookSide = isYes === isBuy ? "bid" : "ask";
  const bookPrice = isYes ? limitCents / 100 : (100 - limitCents) / 100;

  return {
    ticker,
    client_order_id: crypto.randomUUID(),
    side: bookSide,
    count: contracts.toFixed(2),
    price: bookPrice.toFixed(4),
    // Take the price that is showing or do not trade. Never rest on the book,
    // because a resting order in a fifteen minute window is a stale opinion.
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
    reduce_only: !isBuy,
    // Kalshi runs commodities on its own exchange shard. The market object
    // carries the index; omitting it sends the order to shard 0, where the
    // account has no balance and Kalshi answers "Exchange user not found".
    exchange_index: exchangeIndex,
  };
}

/** Kalshi V2 order path. The old /portfolio/orders returns 410. */
export const ORDER_PATH = "/portfolio/events/orders";

/** Append-only log. Every signal, order, fill and settlement lands here. */
export class TradeLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "trades.jsonl");
    fs.mkdirSync(dir, { recursive: true });
  }

  append(record) {
    const row = { at: new Date().toISOString(), ...record };
    try {
      fs.appendFileSync(this.file, JSON.stringify(row) + "\n");
    } catch (err) {
      console.warn(`  trade log write failed: ${err.message}`);
    }
    return row;
  }

  all() {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Closed trades. Only real fills by default: the log also holds dry-run
   * trades and orders that were accepted but never filled, and counting those
   * makes the record look like wins it never had.
   */
  closed({ liveOnly = true } = {}) {
    return this.all().filter(
      (r) =>
        r.kind === "close" &&
        typeof r.pnl === "number" &&
        (!liveOnly || r.live === true)
    );
  }
}

/**
 * Settle an open position against the window's result.
 * Kalshi puts the outcome on the market record once it resolves.
 */
export function settlePosition(pos, market) {
  const result = (market?.result || "").toLowerCase();
  if (result !== "yes" && result !== "no") return null;
  const won = result === pos.side.toLowerCase();
  const pnl = won ? pos.contracts * (1 - pos.entry) : -pos.contracts * pos.entry;
  return {
    kind: "close",
    how: "settled",
    ticker: pos.ticker,
    label: pos.label,
    side: pos.side,
    contracts: pos.contracts,
    entry: pos.entry,
    result,
    won,
    pnl: pnl - (pos.entryFee || 0),
    predictedFair: pos.predictedFair ?? null,
    closedAt: Date.now(),
  };
}

/** Close a position early by selling into the bid. */
export function closeEarly(pos, bidDollars, exitFee) {
  const gross = pos.contracts * (bidDollars - pos.entry);
  return {
    kind: "close",
    how: "sold",
    ticker: pos.ticker,
    label: pos.label,
    side: pos.side,
    contracts: pos.contracts,
    entry: pos.entry,
    exit: bidDollars,
    pnl: gross - exitFee - (pos.entryFee || 0),
    predictedFair: pos.predictedFair ?? null,
    closedAt: Date.now(),
  };
}

/**
 * How well did the fair values actually predict outcomes? This is the number
 * that decides whether the strategy works, and it is the reason every trade
 * records what the model believed at entry.
 */
export function calibration(closedTrades) {
  // A trade that was cut early has no explicit win/loss flag, only a P&L.
  // Counting only the flagged ones showed "13/13" while the account was down,
  // because every cut was invisible. A trade is a win if it made money.
  const scored = closedTrades
    .filter((t) => typeof t.predictedFair === "number")
    .map((t) => ({ ...t, won: typeof t.won === "boolean" ? t.won : t.pnl > 0 }));
  if (scored.length === 0) return null;
  const buckets = new Map();
  for (const t of scored) {
    const b = Math.floor(t.predictedFair * 10) / 10;
    const cur = buckets.get(b) || { predicted: 0, won: 0, n: 0 };
    cur.predicted += t.predictedFair;
    cur.won += t.won ? 1 : 0;
    cur.n += 1;
    buckets.set(b, cur);
  }
  return {
    trades: scored.length,
    wins: scored.filter((t) => t.won).length,
    totalPnl: closedTrades.reduce((s, t) => s + t.pnl, 0),
    buckets: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, v]) => ({
        bucket,
        n: v.n,
        modelSaid: v.predicted / v.n,
        actuallyWon: v.won / v.n,
      })),
  };
}

/**
 * How many contracts actually filled.
 *
 * These are immediate-or-cancel orders: Kalshi answers 201 for an order it
 * accepted, then fills what it can and cancels the rest. An unfilled order and
 * a fully filled one both come back 201, so treating the response code as proof
 * of a position invents holdings that do not exist. Only fill_count is real.
 */
export function filledCount(response) {
  if (!response) return 0;
  const raw = response.fill_count ?? response.filled_count ?? response.order?.fill_count;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * Manage an open position: take profit, cut it, or leave it alone.
 *
 * Deliberately price-based rather than model-based. The fair value already
 * decided the entry; letting it also drive the exit means one bad volatility
 * estimate can both open a position and panic out of it.
 *
 * @param {object} pos    {side, entry, contracts}
 * @param {object} market {yesBid, noBid, secondsLeft}
 * @param {object} rules  {takeProfitCents, stopLossCents, holdIfSecondsLeft}
 */
/**
 * The exit rules that apply to one position, given how confident the model was
 * when it opened.
 *
 * Two tiers, because the gain available differs. A position opened around 82c
 * can make 18c by settling but 8c by selling at 90c, and grabbing the 8c early
 * is worth the second fee. One opened at 88c can only make 12c by settling and
 * 2c by selling at 90c, so the target is pointless and it should ride.
 */
export function rulesFor(pos, cfg) {
  const fair = pos.predictedFair;
  const tiered =
    cfg.takeProfitBelowFair != null &&
    typeof fair === "number" &&
    fair >= cfg.takeProfitBelowFair;
  return {
    takeProfitCents: tiered ? null : cfg.takeProfitCents,
    stopLossCents:
      cfg.stopLossPercent != null
        ? pos.entry * 100 * (cfg.stopLossPercent / 100)
        : cfg.stopLossCents,
    holdIfSecondsLeft: cfg.holdIfSecondsLeft,
    minGainCents: cfg.minGainCents,
  };
}

export function manage(pos, market, rules) {
  const bid = pos.side === "YES" ? market.yesBid : market.noBid;
  if (bid == null || bid <= 0) return { call: "HOLD", reason: "No bid to sell into" };

  const bidCents = bid * 100;
  const entryCents = pos.entry * 100;

  // Near the close, stop managing. Selling now pays a fee to dodge a coin flip
  // that is nearly resolved anyway, and the book is at its thinnest.
  if (market.secondsLeft != null && market.secondsLeft <= (rules.holdIfSecondsLeft ?? 120)) {
    return { call: "HOLD", reason: "Close to settlement, riding it out", bidCents };
  }

  // The target is an absolute price, but entries land anywhere above the
  // conviction floor. Entering at 89 and selling at 90 is a one-cent gain
  // against roughly two cents of fees, so the target has to clear the entry
  // by a real margin before it means anything.
  const target = Math.max(
    rules.takeProfitCents ?? Infinity,
    entryCents + (rules.minGainCents ?? 0)
  );

  // A contract never trades above 99c. An entry so high that entry + minGain
  // exceeds that has no reachable target: it can only stop out or settle.
  const targetReachable = target <= 99;

  if (rules.takeProfitCents != null && targetReachable && bidCents >= target) {
    return {
      call: "TAKE PROFIT",
      reason: `Bid reached ${bidCents.toFixed(0)}c, target was ${target.toFixed(0)}c`,
      bidCents,
      gainCents: bidCents - entryCents,
    };
  }

  if (rules.stopLossCents != null && bidCents <= entryCents - rules.stopLossCents) {
    return {
      call: "CUT",
      reason: `Bid fell ${(entryCents - bidCents).toFixed(0)}c below the ${entryCents.toFixed(0)}c entry`,
      bidCents,
      gainCents: bidCents - entryCents,
    };
  }

  return {
    call: "HOLD",
    reason:
      rules.takeProfitCents == null
        ? `Bid ${bidCents.toFixed(0)}c, riding to settlement unless it hits the ${(entryCents - rules.stopLossCents).toFixed(0)}c stop`
        : targetReachable
        ? `Bid ${bidCents.toFixed(0)}c, between the ${(entryCents - rules.stopLossCents).toFixed(0)}c stop and the ${target.toFixed(0)}c target`
        : `Bid ${bidCents.toFixed(0)}c, no reachable target from a ${entryCents.toFixed(0)}c entry, stop or settlement only`,
    bidCents,
    targetReachable,
  };
}

/**
 * How far below the bid to offer when cutting a position.
 *
 * An exit priced exactly at the last seen bid is cancelled by any tick against
 * you, so in a fast move the stop fires, fails, and refires while the position
 * keeps falling. On 17 Sep that turned a 20% stop into a 48% loss. Each failed
 * attempt widens the concession: getting out is worth more than the last cent.
 */
export function cutPrice(bidCents, attempts, cfg) {
  const base = cfg.cutConcessionCents ?? 3;
  const max = cfg.maxCutConcessionCents ?? 15;
  const concession = Math.min(base + attempts, max);
  return Math.max(1, Math.round(bidCents - concession));
}
