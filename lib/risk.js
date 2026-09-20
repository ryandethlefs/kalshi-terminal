// Risk engine. Every order passes through here before it reaches Kalshi.
// Pure functions, no network, no clock, so each rule can be tested directly.
//
// The rules are deliberately boring. A trading bot loses money through the
// path nobody tested, so the checks that matter are the ones that say no.

import { orderFee } from "./model.js";

export const HALT_REASONS = {
  DISARMED: "Bot is not armed",
  DAILY_LOSS: "Daily loss limit reached",
  KILLED: "Kill switch pulled",
  MAX_OPEN: "Too many positions open",
  MAX_EXPOSURE: "Too much money already at risk",
  STAKE_TOO_BIG: "Order larger than the per-trade cap",
  STALE: "Market data is stale",
  DUPLICATE: "Already holding this window",
  NO_ROOM: "Remaining daily budget cannot cover the stake",
  NO_COLLATERAL: "Not enough collateral on this market's exchange shard",
};

/**
 * Decide whether a proposed order may be sent.
 *
 * @param {object} order   {ticker, side, limitCents, contracts}
 * @param {object} state   {armed, killed, realizedToday, openPositions[], dataAgeSec}
 * @param {object} limits  {dailyLossLimit, maxStakePerTrade, maxOpenPositions,
 *                          maxTotalExposure, maxDataAgeSec, shardBalance}
 * @returns {{allowed: boolean, reason: string|null, stake: number, fee: number, worstCase: number}}
 */
export function checkOrder(order, state, limits) {
  const price = order.limitCents / 100;
  const stake = order.contracts * price;
  const fee = order.contracts > 0 ? orderFee(price, order.contracts) : 0;
  // A binary settles at zero. The worst case is the whole stake plus the fee.
  const worstCase = stake + fee;

  const deny = (reason) => ({ allowed: false, reason, stake, fee, worstCase });

  if (state.killed) return deny(HALT_REASONS.KILLED);
  if (!state.armed) return deny(HALT_REASONS.DISARMED);
  if (order.contracts < 1) return deny(HALT_REASONS.STAKE_TOO_BIG);

  // Per-trade cap first: when an order breaks several rules at once, the most
  // specific reason is the useful one to log.
  if (worstCase > limits.maxStakePerTrade) return deny(HALT_REASONS.STAKE_TOO_BIG);

  // realizedToday is negative when down on the day.
  const lostToday = Math.max(0, -state.realizedToday);
  if (lostToday >= limits.dailyLossLimit) return deny(HALT_REASONS.DAILY_LOSS);

  // Never let one order push the day past the stop in the worst case.
  const roomLeft = limits.dailyLossLimit - lostToday;
  if (worstCase > roomLeft) return deny(HALT_REASONS.NO_ROOM);

  const open = state.openPositions || [];
  if (open.length >= limits.maxOpenPositions) return deny(HALT_REASONS.MAX_OPEN);

  if (open.some((p) => p.ticker === order.ticker)) return deny(HALT_REASONS.DUPLICATE);

  const exposure = open.reduce((sum, p) => sum + p.contracts * p.entry, 0);
  if (exposure + worstCase > limits.maxTotalExposure) return deny(HALT_REASONS.MAX_EXPOSURE);

  if (state.dataAgeSec != null && state.dataAgeSec > limits.maxDataAgeSec) {
    return deny(HALT_REASONS.STALE);
  }

  // Configured caps are not the same as money that exists. Kalshi checks
  // collateral inside the matching engine for the shard the market trades on,
  // so an order sized off a cap alone is rejected when the shard is short.
  if (limits.shardBalance != null && worstCase > limits.shardBalance) {
    return deny(HALT_REASONS.NO_COLLATERAL);
  }

  return { allowed: true, reason: null, stake, fee, worstCase };
}

/**
 * Largest order that fits every limit at this price. Returns 0 when nothing fits,
 * which is a normal answer and must not be treated as an error.
 */
export function maxContractsAllowed(limitCents, state, limits) {
  const price = limitCents / 100;
  if (!(price > 0) && price < 1) return 0;
  const lostToday = Math.max(0, -state.realizedToday);
  const roomLeft = limits.dailyLossLimit - lostToday;
  const open = state.openPositions || [];
  const exposure = open.reduce((sum, p) => sum + p.contracts * p.entry, 0);

  const budget = Math.min(
    roomLeft,
    limits.maxStakePerTrade,
    limits.maxTotalExposure - exposure,
    limits.shardBalance ?? Infinity
  );
  if (budget <= 0) return 0;

  // Walk down until the stake plus its rounded-up fee fits the budget.
  let n = Math.floor(budget / price);
  while (n > 0 && n * price + orderFee(price, n) > budget) n--;
  return Math.max(0, n);
}

/**
 * Realized profit or loss for the day, from REAL closed trades only.
 *
 * The trade log holds dry-run trades, orders that were accepted but never
 * filled, and genuine fills side by side. Counting them together let imaginary
 * profits offset real losses: on 17 Sep the stop read -$4.72 while the account
 * was actually down $6.17, so the daily limit never fired. Only records
 * explicitly marked live count.
 */
export function realizedPnl(trades, dayStartMs) {
  return trades
    .filter((t) => t.live === true && t.closedAt != null && t.closedAt >= dayStartMs)
    .reduce((sum, t) => sum + t.pnl, 0);
}

/** Should the bot halt itself right now? */
export function haltCheck(state, limits) {
  if (state.killed) return { halted: true, reason: HALT_REASONS.KILLED };
  const lostToday = Math.max(0, -state.realizedToday);
  if (lostToday >= limits.dailyLossLimit) {
    return { halted: true, reason: HALT_REASONS.DAILY_LOSS };
  }
  return { halted: false, reason: null };
}
