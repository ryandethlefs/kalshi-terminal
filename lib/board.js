// Decision logic. Pure functions: state goes in, calls come out. No network,
// no clocks, no globals, so the rules that decide whether to put money at risk
// can be tested directly.

import { feePerContract, orderFee, fairYes, kellyFraction } from "./model.js";

const centsToDollars = (c) => (c == null ? null : c / 100);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {object}  s        series config, {ticker, label}
 * @param {object?} market   the live Kalshi market, or null
 * @param {object?} ref      {k, source} reference price for this window
 * @param {object?} spot     {price, t} latest settlement price
 * @param {object}  vol      {sigma, samples}
 * @param {object}  E        engine config
 * @param {number}  bankroll dollars
 * @param {number}  now      ms timestamp
 * @param {string?} error    last fetch error for this series
 */
/** How many settlement samples are already fixed, if this is an averaged market. */
const bankedCount = (E) => (Array.isArray(E.banked) ? E.banked.length : 0);

/**
 * Is enough of the settlement average already banked to trust near-certainty?
 *
 * Half the samples means half the answer cannot move. Below that, a pinned
 * fair value is still the model overreaching.
 */
const banked = (E) => bankedCount(E) >= 30;

/**
 * The edge ceiling, widened as settlement samples accumulate.
 *
 * With nothing banked this is the ordinary ceiling. Once samples are fixed the
 * model legitimately knows things a last-print book does not, and the gap it
 * reports is real rather than a broken volatility estimate.
 */
function edgeCeiling(E) {
  if (E.maxEdgeCents == null) return null;
  const n = bankedCount(E);
  if (n === 0) return E.maxEdgeCents;
  const relaxed = E.maxEdgeCentsBanked ?? 40;
  return E.maxEdgeCents + (relaxed - E.maxEdgeCents) * Math.min(1, n / 45);
}

export function buildRow(s, market, ref, spot, vol, E, bankroll, now, error) {
  const row = {
    ticker: s.ticker,
    label: s.label,
    error: error || null,
    market: null,
    action: { call: "WAIT", reason: "No open window" },
  };

  if (!market) {
    row.action = error
      ? { call: "ERROR", reason: error }
      : { call: "CLOSED", reason: "No open window right now" };
    return row;
  }

  const tau = (new Date(market.close_time).getTime() - now) / 1000;
  const yesAsk = centsToDollars(market.yes_ask);
  const yesBid = centsToDollars(market.yes_bid);
  const noAsk = centsToDollars(market.no_ask);
  const noBid = centsToDollars(market.no_bid);
  const mid = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : null;
  const spreadCents = yesBid != null && yesAsk != null ? (yesAsk - yesBid) * 100 : null;

  row.market = {
    contractTicker: market.ticker,
    closeTime: market.close_time,
    secondsLeft: tau,
    reference: ref ? ref.k : null,
    referenceSource: ref ? ref.source : null,
    spot: spot ? spot.price : null,
    spotAgeSec: spot ? (now - spot.t) / 1000 : null,
    gap: ref && spot ? spot.price - ref.k : null,
    volSamples: vol.samples,
    volSpanSec: vol.spanSec ?? null,
    sigmaPerMin: vol.sigma ? vol.sigma * Math.sqrt(60) : null,
    yesBid, yesAsk, noBid, noAsk, mid, spreadCents,
    volume: market.volume ?? null,
    openInterest: market.open_interest ?? null,
    fair: null,
    yes: null,
    no: null,
  };

  if (!ref || !spot || !vol.sigma || tau <= 0) {
    row.action = {
      call: "WAIT",
      reason: !ref
        ? "Reference price for this window not identified yet"
        : !spot
        ? "No live price feed"
        : !vol.sigma
        ? `Measuring how much it moves, ${Math.max(0, Math.round((E.minVolSpanSec - (vol.spanSec || 0)) / 60))} min to go`
        : "Window closing",
    };
    return row;
  }

  // A price feed that has gone quiet is worse than no feed, because it looks fine.
  if (row.market.spotAgeSec > 15) {
    row.action = { call: "WAIT", reason: `Price feed stale by ${row.market.spotAgeSec.toFixed(0)}s` };
    return row;
  }

  // Crypto windows settle on a 60-second average, not a closing print, so
  // they price through a different function. See lib/crypto.js.
  const p = E.fairFn
    ? E.fairFn(spot.price, ref.k, vol.sigma, tau, E.banked || [])
    : fairYes(spot.price, ref.k, vol.sigma, tau);
  if (p == null) {
    row.action = { call: "WAIT", reason: "Fair value inputs not usable yet" };
    return row;
  }
  row.market.fair = p;

  const priceSide = (win, ask) => {
    if (ask == null || ask <= 0 || ask >= 1) return null;
    const fee = feePerContract(ask);
    return { ask, fee, allIn: ask + fee, breakeven: ask + fee, evCents: (win - (ask + fee)) * 100, win };
  };
  row.market.yes = priceSide(p, yesAsk);
  row.market.no = priceSide(1 - p, noAsk);

  const best =
    [
      row.market.yes ? { side: "YES", ...row.market.yes } : null,
      row.market.no ? { side: "NO", ...row.market.no } : null,
    ]
      .filter(Boolean)
      .sort((a, b) => b.evCents - a.evCents)[0] || null;

  if (tau < E.minSecondsLeft) {
    row.action = { call: "STAND DOWN", reason: "Too little time left to act" };
  } else if (tau > E.maxSecondsLeft) {
    row.action = {
      call: "WAIT",
      reason: `Waiting for the last ${Math.round(E.maxSecondsLeft / 60)} minutes, ${Math.round((tau - E.maxSecondsLeft) / 60)} min to go`,
    };
  } else if (spreadCents != null && spreadCents > E.maxSpreadCents) {
    row.action = { call: "SKIP", reason: `Book too wide, ${spreadCents.toFixed(0)}c spread` };
  } else if ((p >= 0.999 || p <= 0.001) && !banked(E)) {
    // Fair value has hit the clamp. The model is out of resolution and is
    // asserting near-certainty, which on a live book means the inputs are
    // wrong, not that free money is sitting there.
    //
    // The exception is a settlement average with most of its samples already
    // taken. There, near-certainty is arithmetic about values that are already
    // fixed, not an extrapolation, so the guard would refuse the one case the
    // model genuinely knows something about.
    row.action = {
      call: "MODEL OFF",
      reason: `Fair value pinned at ${(p * 100).toFixed(2)}c, inputs are not trustworthy`,
    };
  } else if (best && edgeCeiling(E) != null && best.evCents > edgeCeiling(E)) {
    // A ceiling on edge. These markets are liquid and tightly priced; an edge
    // this large is usually evidence the model has broken, not an opportunity.
    // Without it, a bad volatility estimate reads as the trade of the day.
    //
    // On a settlement average the ceiling lifts as samples bank, because a
    // large disagreement with a book priced off the last print is then the
    // expected result rather than a symptom.
    row.action = {
      call: "MODEL OFF",
      reason: `Edge of ${best.evCents.toFixed(0)}c is too large to believe, refusing`,
    };
  } else if (best && E.maxEntryCents != null && E.maxEntryCents > 0 && best.ask * 100 > E.maxEntryCents) {
    // Too expensive to be worth owning: at 90c you risk 90 to win 10, and there
    // is no room left between the entry and any sensible profit target.
    row.action = {
      call: "TOO PRICEY",
      reason: `${(best.ask * 100).toFixed(0)}c leaves too little upside`,
    };
  } else if (best && E.minFairToEnter != null && best.win < E.minFairToEnter) {
    // Only take positions the model already considers likely. Paying up for a
    // "solid" contract is not free: at 75c you must be right 76% of the time
    // just to break even, so this only works alongside a stop.
    row.action = {
      call: "NOT SOLID",
      reason: `Best side is only ${(best.win * 100).toFixed(0)}c, under the ${(E.minFairToEnter * 100).toFixed(0)}c floor`,
    };
  } else if (!best || best.evCents < E.minEdgeCents) {
    row.action = {
      call: "NO TRADE",
      reason: best
        ? `Best edge ${best.evCents.toFixed(1)}c does not clear the fee band`
        : "No priced side",
    };
  } else {
    const kelly = kellyFraction(best.win, best.allIn);
    const stake = Math.max(0, bankroll * kelly * E.kellyFraction);
    const contracts = clamp(Math.floor(stake / best.ask), 0, E.maxContracts);
    row.action =
      contracts < 1
        ? { call: "NO TRADE", reason: "Edge is real but too small for one contract at this bankroll" }
        : {
            call: `BUY ${best.side}`,
            reason: `Fair ${(best.win * 100).toFixed(0)}c against an all-in cost of ${(best.allIn * 100).toFixed(1)}c`,
            side: best.side,
            limitCents: Math.round(best.ask * 100),
            evCents: best.evCents,
            contracts,
            stake: contracts * best.ask,
            fee: orderFee(best.ask, contracts),
            kelly,
          };
  }
  return row;
}

/** Should an open position be closed now, or ridden to settlement? */
export function exitCall(row, pos, E) {
  const m = row.market;
  if (!m || m.fair == null) return { call: "HOLD", reason: "No fair value right now" };

  const isYes = pos.side === "YES";
  const bid = isYes ? m.yesBid : m.noBid;
  const holdValue = isYes ? m.fair : 1 - m.fair;
  if (bid == null || bid <= 0) return { call: "HOLD", reason: "No bid to sell into" };

  // Selling is a taker order, so the fee comes out of the proceeds.
  const exitNet = bid - feePerContract(bid);
  const gainCents = (exitNet - holdValue) * 100;
  const fee = orderFee(bid, pos.contracts);
  const pnl = pos.contracts * (bid - pos.entry) - fee;

  let call = "HOLD";
  let reason = `Selling nets ${(exitNet * 100).toFixed(1)}c against ${(holdValue * 100).toFixed(1)}c for holding`;
  if (m.secondsLeft < E.minSecondsLeft) {
    reason = "Too late to exit cleanly, ride it to settlement";
  } else if (gainCents >= E.exitEdgeCents) {
    call = "CASH OUT";
    reason = `The bid sits ${gainCents.toFixed(1)}c above fair value, after the fee`;
  }

  return {
    call,
    reason,
    bidCents: bid * 100,
    exitNetCents: exitNet * 100,
    holdValueCents: holdValue * 100,
    gainCents,
    pnl,
    fee,
    settleWin: pos.contracts * (1 - pos.entry),
    settleLose: -pos.contracts * pos.entry,
  };
}
