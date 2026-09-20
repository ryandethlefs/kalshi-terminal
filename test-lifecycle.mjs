// One trade, end to end, through the real modules: signal, sizing, risk check,
// order, settlement, P&L, and the daily stop kicking in.
import assert from "node:assert/strict";
import { buildRow } from "./lib/board.js";
import { checkOrder, maxContractsAllowed, realizedPnl, haltCheck } from "./lib/risk.js";
import { buildOrder, settlePosition, TradeLog, calibration } from "./lib/execution.js";
import fs from "node:fs";

const E = { minVolSamples: 30, minVolSpanSec: 600, maxEdgeCents: 8, minSecondsLeft: 20, maxSecondsLeft: 870,
            minEdgeCents: 1.5, exitEdgeCents: 1, maxSpreadCents: 6, kellyFraction: 0.25, maxContracts: 200 };
const L = { dailyLossLimit: 5, maxStakePerTrade: 2.5, maxOpenPositions: 2, maxTotalExposure: 5, maxDataAgeSec: 10 };
const NOW = 1_700_000_000_000;

let pass = 0;
const t = (n, f) => { f(); pass++; console.log("  ok  " + n); };

const market = {
  ticker: "KXGOLD15M-LIVE", close_time: new Date(NOW + 300_000).toISOString(),
  yes_bid: 84, yes_ask: 86, no_bid: 14, no_ask: 16, volume: 4000, open_interest: 2000,
};
const row = buildRow({ ticker: "KXGOLD15M", label: "Gold" }, market,
  { k: 4200, source: "t" }, { price: 4202, t: NOW },
  { sigma: 0.00002, samples: 500, spanSec: 900 }, E, 50, NOW, null);

t("the board produces a buy signal", () => {
  assert.ok(row.action.call.startsWith("BUY"), row.action.call + " / " + row.action.reason);
});

const state = { armed: true, killed: false, realizedToday: 0, openPositions: [], dataAgeSec: 1 };
const size = maxContractsAllowed(row.action.limitCents, state, L);

t("risk sizes it down to what a $50 account can carry", () => {
  // The board wanted a Kelly size off the bankroll; risk must cap it far lower.
  assert.ok(size >= 1, "nothing sized");
  assert.ok(size < row.action.contracts, `${size} should be under the board's ${row.action.contracts}`);
  assert.ok(size * row.action.limitCents / 100 <= L.maxStakePerTrade);
});

const order = { ticker: market.ticker, side: row.action.side, limitCents: row.action.limitCents, contracts: size };
const verdict = checkOrder(order, state, L);

t("the sized order passes every risk rule", () => {
  assert.equal(verdict.allowed, true, verdict.reason);
  assert.ok(verdict.worstCase <= L.maxStakePerTrade);
});

t("the payload matches the signal, on the correct book side", () => {
  const p = buildOrder(order);
  assert.equal(p.count, size.toFixed(2));
  const expectSide = order.side === "YES" ? "bid" : "ask";
  assert.equal(p.side, expectSide);
  const expectPrice = order.side === "YES"
    ? (order.limitCents / 100).toFixed(4)
    : ((100 - order.limitCents) / 100).toFixed(4);
  assert.equal(p.price, expectPrice);
});

const pos = { ticker: market.ticker, label: "Gold", side: order.side, contracts: size,
              entry: order.limitCents / 100, entryFee: verdict.fee, predictedFair: row.market.fair };

t("a loss is recorded with the fee included", () => {
  const rec = settlePosition(pos, { result: "no" });
  assert.equal(rec.won, false);
  assert.ok(rec.pnl < -pos.contracts * pos.entry, "fee missing from the loss");
});

t("a win is recorded with the fee included", () => {
  const rec = settlePosition(pos, { result: "yes" });
  assert.equal(rec.won, true);
  assert.ok(rec.pnl < pos.contracts * (1 - pos.entry), "fee missing from the win");
});

t("enough losses trip the daily stop and stop further orders", () => {
  const dir = "/tmp/lc-" + Date.now();
  const log = new TradeLog(dir);
  let guard = 0;
  while (Math.abs(realizedPnl(log.closed(), 0)) < L.dailyLossLimit && guard++ < 50) {
    log.append(settlePosition(pos, { result: "no" }));
  }
  const lost = realizedPnl(log.closed(), 0);
  assert.ok(lost <= -L.dailyLossLimit, `only lost ${lost}`);
  assert.ok(guard < 50, "stop never tripped");

  const halted = haltCheck({ killed: false, realizedToday: lost }, L);
  assert.equal(halted.halted, true);

  const after = checkOrder(order, { ...state, realizedToday: lost }, L);
  assert.equal(after.allowed, false);
  console.log(`      (took ${guard} losing trades to hit the $${L.dailyLossLimit} stop)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

t("the log can score the model against reality", () => {
  const closed = [
    settlePosition({ ...pos, predictedFair: 0.9 }, { result: "yes" }),
    settlePosition({ ...pos, predictedFair: 0.9 }, { result: "no" }),
  ].map((r) => ({ ...r, won: r.won }));
  const c = calibration(closed);
  assert.equal(c.trades, 2);
  assert.equal(c.buckets[0].modelSaid, 0.9);
  assert.equal(c.buckets[0].actuallyWon, 0.5);
});

console.log(`\n${pass} lifecycle tests passed\n`);
