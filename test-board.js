import assert from "node:assert/strict";
import { buildRow, exitCall } from "./lib/board.js";

const E = {
  minVolSamples: 30,
  minVolSpanSec: 600, minSecondsLeft: 20, maxSecondsLeft: 870,
  minEdgeCents: 1.5, maxEdgeCents: 8, exitEdgeCents: 1.0, maxSpreadCents: 6,
  kellyFraction: 0.25, maxContracts: 200,
};
const NOW = 1_700_000_000_000;
const S = { ticker: "KXGOLD15M", label: "Gold" };

const mkt = (o = {}) => ({
  ticker: "KXGOLD15M-TEST",
  close_time: new Date(NOW + (o.tau ?? 400) * 1000).toISOString(),
  yes_bid: o.yb ?? 48, yes_ask: o.ya ?? 52,
  no_bid: o.nb ?? 48, no_ask: o.na ?? 52,
  volume: 5000, open_interest: 2000,
});
const ref = (k = 4200) => ({ k, source: "test" });
const spot = (p = 4200, age = 0) => ({ price: p, t: NOW - age * 1000 });
const vol = (sigma = 0.00002, samples = 200) => ({ sigma, samples, spanSec: 900 });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

t("no open window reads as closed, not as an opportunity", () => {
  const r = buildRow(S, null, null, null, vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "CLOSED");
});

t("a fetch failure surfaces as an error, never as a trade", () => {
  const r = buildRow(S, null, null, null, vol(), E, 1000, NOW, "401 unauthorized");
  assert.equal(r.action.call, "ERROR");
  assert.match(r.action.reason, /401/);
});

t("waits while it is still measuring how much the market moves", () => {
  const r = buildRow(S, mkt(), ref(), spot(), { sigma: null, samples: 4, spanSec: 20 }, E, 1000, NOW, null);
  assert.equal(r.action.call, "WAIT");
  assert.match(r.action.reason, /Measuring/);
});

t("a thin sigma from too little history cannot produce a trade", () => {
  // This is the exact failure that showed silver at 2.5c against a 21c book:
  // sixty seconds of quiet data gave a sigma roughly half the real one.
  const thin = { sigma: null, samples: 30, spanSec: 60 };
  const r = buildRow(S, mkt({ tau: 400, yb: 21, ya: 23, nb: 77, na: 79 }), ref(65.241), spot(65.212), thin, E, 1000, NOW, null);
  assert.equal(r.action.call, "WAIT");
  assert.ok(!r.action.call.startsWith("BUY"));
});

t("waits when the reference price has not been pinned down", () => {
  const r = buildRow(S, mkt(), null, spot(), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "WAIT");
  assert.match(r.action.reason, /Reference price/);
});

t("a stale price feed blocks trading instead of pricing off old data", () => {
  const r = buildRow(S, mkt(), ref(), spot(4200, 45), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "WAIT");
  assert.match(r.action.reason, /stale/);
});

t("a genuine coin flip priced at 50 cents is a no trade", () => {
  const r = buildRow(S, mkt({ yb: 49, ya: 51, nb: 49, na: 51 }), ref(4200), spot(4200), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "NO TRADE");
  assert.match(r.action.reason, /fee band/);
});

t("a wide book is skipped even when the edge looks good", () => {
  const r = buildRow(S, mkt({ yb: 60, ya: 75, nb: 25, na: 40 }), ref(4200), spot(4206), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "SKIP");
  assert.match(r.action.reason, /wide/);
});

t("stands down in the last seconds", () => {
  const r = buildRow(S, mkt({ tau: 10, yb: 84, ya: 86 }), ref(4200), spot(4202), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "STAND DOWN");
});

t("waits at the very top of a window", () => {
  const r = buildRow(S, mkt({ tau: 890, yb: 84, ya: 86 }), ref(4200), spot(4202), vol(), E, 1000, NOW, null);
  assert.equal(r.action.call, "WAIT");
});

t("buys YES when the market underprices a real move up", () => {
  // Spot modestly above reference with 5 minutes left. Fair lands near 92c
  // while the book asks 86c, which is a believable gap rather than a pinned one.
  const r = buildRow(S, mkt({ tau: 300, yb: 84, ya: 86, nb: 14, na: 16 }), ref(4200), spot(4202), vol(), E, 2000, NOW, null);
  assert.ok(r.action.call === "BUY YES", r.action.call + " / " + r.action.reason);
  assert.ok(r.action.contracts > 0);
  assert.ok(r.action.evCents >= E.minEdgeCents);
  assert.equal(r.action.limitCents, 86);
  // Sizing must stay inside the bankroll.
  assert.ok(r.action.stake <= 2000, "stake " + r.action.stake);
});

t("buys NO when the market underprices a real move down", () => {
  const r = buildRow(S, mkt({ tau: 300, yb: 14, ya: 16, nb: 84, na: 86 }), ref(4200), spot(4198), vol(), E, 2000, NOW, null);
  assert.equal(r.action.call, "BUY NO");
  assert.equal(r.action.limitCents, 86);
});

t("a tiny bankroll produces no trade rather than a zero-contract order", () => {
  const r = buildRow(S, mkt({ tau: 300, yb: 84, ya: 86, nb: 14, na: 16 }), ref(4200), spot(4202), vol(), E, 1, NOW, null);
  assert.equal(r.action.call, "NO TRADE");
  assert.match(r.action.reason, /one contract/);
});

t("position sizing scales with the bankroll", () => {
  const m = mkt({ tau: 300, yb: 84, ya: 86, nb: 14, na: 16 });
  const small = buildRow(S, m, ref(4200), spot(4202), vol(), E, 50, NOW, null);
  const big = buildRow(S, m, ref(4200), spot(4202), vol(), E, 200, NOW, null);
  assert.ok(big.action.contracts > small.action.contracts, `${small.action.contracts} then ${big.action.contracts}`);
});

t("the contract cap binds no matter how large the bankroll", () => {
  const m = mkt({ tau: 300, yb: 84, ya: 86, nb: 14, na: 16 });
  const huge = buildRow(S, m, ref(4200), spot(4202), vol(), E, 5_000_000, NOW, null);
  assert.equal(huge.action.contracts, E.maxContracts);
});

/* ---- exits ---- */

t("holds when the bid is below what the position is worth", () => {
  const row = buildRow(S, mkt({ tau: 300, yb: 55, ya: 57, nb: 43, na: 45 }), ref(4200), spot(4206), vol(), E, 1000, NOW, null);
  const x = exitCall(row, { side: "YES", entry: 0.5, contracts: 50 }, E);
  assert.equal(x.call, "HOLD");
});

t("cashes out when the bid runs ahead of fair value", () => {
  // Spot back at the reference so fair value is near 50, but the book still bids 70.
  const row = buildRow(S, mkt({ tau: 300, yb: 70, ya: 72, nb: 28, na: 30 }), ref(4200), spot(4200), vol(), E, 1000, NOW, null);
  const x = exitCall(row, { side: "YES", entry: 0.45, contracts: 50 }, E);
  assert.equal(x.call, "CASH OUT");
  assert.ok(x.gainCents >= E.exitEdgeCents);
  // 50 contracts, bought at 45c, selling at 70c, minus the exit fee.
  assert.ok(x.pnl > 11 && x.pnl < 12.5, "pnl " + x.pnl);
});

t("exit P&L subtracts the fee rather than quoting a gross number", () => {
  const row = buildRow(S, mkt({ tau: 300, yb: 70, ya: 72, nb: 28, na: 30 }), ref(4200), spot(4200), vol(), E, 1000, NOW, null);
  const x = exitCall(row, { side: "YES", entry: 0.45, contracts: 50 }, E);
  const gross = 50 * (0.70 - 0.45);
  assert.ok(x.pnl < gross, "fee was not deducted");
  assert.ok(x.fee > 0);
});

t("never tells you to exit in the final seconds", () => {
  const row = buildRow(S, mkt({ tau: 8, yb: 70, ya: 72, nb: 28, na: 30 }), ref(4200), spot(4200), vol(), E, 1000, NOW, null);
  const x = exitCall(row, { side: "YES", entry: 0.45, contracts: 50 }, E);
  assert.equal(x.call, "HOLD");
  assert.match(x.reason, /Too late/);
});

t("shows both settlement outcomes so the downside is never hidden", () => {
  const row = buildRow(S, mkt({ tau: 300 }), ref(4200), spot(4200), vol(), E, 1000, NOW, null);
  const x = exitCall(row, { side: "YES", entry: 0.45, contracts: 50 }, E);
  assert.equal(x.settleWin, 50 * 0.55);
  assert.equal(x.settleLose, -50 * 0.45);
});


/* ---- refusing to believe its own numbers ---- */

t("a fair value pinned at the clamp is refused, not traded", () => {
  // Silver read 0.9999 against a book at 59c and claimed a 39c edge. That is
  // the model failing, not an opportunity.
  const r = buildRow(S, mkt({ tau: 400, yb: 57, ya: 59, nb: 41, na: 43 }),
    ref(65.14), spot(65.60), vol(0.0000005), E, 50, NOW, null);
  assert.equal(r.action.call, "MODEL OFF");
  assert.match(r.action.reason, /pinned/);
});

t("an implausibly large edge is refused", () => {
  const E2 = { ...E, maxEdgeCents: 8 };
  // A large but not pinned fair value: 98c against a book asking 22c.
  const r = buildRow(S, mkt({ tau: 300, yb: 20, ya: 22, nb: 78, na: 80 }),
    ref(4200), spot(4203), vol(0.00002), E2, 50, NOW, null);
  assert.equal(r.action.call, "MODEL OFF", `${r.action.call}: ${r.action.reason}`);
  assert.match(r.action.reason, /too large to believe/);
});

t("an ordinary edge still trades", () => {
  const E2 = { ...E, maxEdgeCents: 8 };
  const r = buildRow(S, mkt({ tau: 300, yb: 84, ya: 86, nb: 14, na: 16 }),
    ref(4200), spot(4202), vol(0.00002), E2, 2000, NOW, null);
  assert.ok(r.action.call.startsWith("BUY"), `${r.action.call}: ${r.action.reason}`);
  assert.ok(r.action.evCents <= E2.maxEdgeCents, `edge ${r.action.evCents}`);
});
console.log(`\n${pass} board tests passed\n`);
