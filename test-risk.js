import assert from "node:assert/strict";
import { checkOrder, maxContractsAllowed, realizedPnl, haltCheck, HALT_REASONS } from "./lib/risk.js";

const L = {
  dailyLossLimit: 5,
  maxStakePerTrade: 2.5,
  maxOpenPositions: 2,
  maxTotalExposure: 5,
  maxDataAgeSec: 10,
};
const armed = (over = {}) => ({
  armed: true, killed: false, realizedToday: 0, openPositions: [], dataAgeSec: 1, ...over,
});
const order = (over = {}) => ({ ticker: "KXGOLD15M-A", side: "YES", limitCents: 45, contracts: 4, ...over });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

/* ---- the refusals ---- */

t("a disarmed bot sends nothing", () => {
  const r = checkOrder(order(), armed({ armed: false }), L);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, HALT_REASONS.DISARMED);
});

t("the kill switch beats every other condition", () => {
  const r = checkOrder(order(), armed({ killed: true }), L);
  assert.equal(r.reason, HALT_REASONS.KILLED);
});

t("no new orders once the daily loss limit is hit", () => {
  const r = checkOrder(order(), armed({ realizedToday: -5 }), L);
  assert.equal(r.reason, HALT_REASONS.DAILY_LOSS);
});

t("an order that could push past the stop is refused before it is sent", () => {
  // Down $4, so only $1 of room. A 4-contract order at 45c risks $1.87.
  const r = checkOrder(order(), armed({ realizedToday: -4 }), L);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, HALT_REASONS.NO_ROOM);
});

t("worst case includes the fee, not just the stake", () => {
  const r = checkOrder(order({ contracts: 5 }), armed(), L);
  assert.ok(r.worstCase > r.stake, "fee was not counted in the worst case");
  assert.equal(r.worstCase.toFixed(2), (5 * 0.45 + r.fee).toFixed(2));
});

t("an oversized order is refused", () => {
  const r = checkOrder(order({ contracts: 50 }), armed(), L);
  assert.equal(r.reason, HALT_REASONS.STAKE_TOO_BIG);
});

t("zero contracts is never sent", () => {
  const r = checkOrder(order({ contracts: 0 }), armed(), L);
  assert.equal(r.allowed, false);
});

t("will not open more positions than the cap", () => {
  const open = [
    { ticker: "A", contracts: 2, entry: 0.4 },
    { ticker: "B", contracts: 2, entry: 0.4 },
  ];
  const r = checkOrder(order(), armed({ openPositions: open }), L);
  assert.equal(r.reason, HALT_REASONS.MAX_OPEN);
});

t("will not double up on a window it already holds", () => {
  const open = [{ ticker: "KXGOLD15M-A", contracts: 2, entry: 0.4 }];
  const r = checkOrder(order(), armed({ openPositions: open }), L);
  assert.equal(r.reason, HALT_REASONS.DUPLICATE);
});

t("total exposure across open positions is capped", () => {
  const tight = { ...L, maxOpenPositions: 5, maxTotalExposure: 2 };
  const open = [{ ticker: "Z", contracts: 4, entry: 0.4 }];
  const r = checkOrder(order(), armed({ openPositions: open }), tight);
  assert.equal(r.reason, HALT_REASONS.MAX_EXPOSURE);
});

t("stale data blocks trading", () => {
  const r = checkOrder(order(), armed({ dataAgeSec: 45 }), L);
  assert.equal(r.reason, HALT_REASONS.STALE);
});

t("a clean order is allowed", () => {
  const r = checkOrder(order(), armed(), L);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

/* ---- sizing ---- */

t("sizing never exceeds the per-trade cap", () => {
  const n = maxContractsAllowed(45, armed(), L);
  const stake = n * 0.45;
  assert.ok(stake <= L.maxStakePerTrade, `${stake} over cap`);
  assert.ok(n > 0);
});

t("sizing shrinks as the day's losses grow", () => {
  const fresh = maxContractsAllowed(45, armed(), L);
  const bruised = maxContractsAllowed(45, armed({ realizedToday: -4 }), L);
  assert.ok(bruised < fresh, `${bruised} should be under ${fresh}`);
});

t("sizing returns zero rather than erroring when nothing fits", () => {
  assert.equal(maxContractsAllowed(45, armed({ realizedToday: -5 }), L), 0);
});

t("a size from the sizer always passes the order check", () => {
  for (const cents of [5, 20, 45, 60, 85, 95]) {
    for (const lost of [0, 1, 2, 3, 4.5]) {
      const state = armed({ realizedToday: -lost });
      const n = maxContractsAllowed(cents, state, L);
      if (n < 1) continue;
      const r = checkOrder(order({ limitCents: cents, contracts: n }), state, L);
      assert.equal(r.allowed, true, `${n} at ${cents}c with $${lost} lost: ${r.reason}`);
    }
  }
});

/* ---- accounting ---- */

t("only closed trades from today count toward the stop", () => {
  const day = 1_700_000_000_000;
  const trades = [
    { closedAt: day - 90_000_000, pnl: -50 },
    { closedAt: day + 1000, pnl: -2 },
    { closedAt: day + 2000, pnl: 0.5 },
    { closedAt: null, pnl: -99 },
  ];
  assert.equal(realizedPnl(trades, day), -1.5);
});

t("halt fires at the limit and not before", () => {
  assert.equal(haltCheck({ realizedToday: -4.99, killed: false }, L).halted, false);
  assert.equal(haltCheck({ realizedToday: -5, killed: false }, L).halted, true);
  assert.equal(haltCheck({ realizedToday: 10, killed: true }, L).halted, true);
});

console.log(`\n${pass} risk tests passed\n`);

/* ---- collateral actually present on the shard ---- */

const withShard = (bal) => ({ ...L, shardBalance: bal });

t("an order larger than the shard's collateral is refused", () => {
  const r = checkOrder(order({ contracts: 4 }), armed(), withShard(0.14));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, HALT_REASONS.NO_COLLATERAL);
});

t("sizing is capped by real collateral, not just configured limits", () => {
  const n = maxContractsAllowed(45, armed(), withShard(0.14));
  assert.equal(n, 0, "45c is unaffordable with 14 cents");
});

t("a cheap contract is affordable with a small balance", () => {
  const n = maxContractsAllowed(5, armed(), withShard(0.14));
  assert.ok(n >= 1 && n <= 2, `sized ${n}`);
  const r = checkOrder(order({ limitCents: 5, contracts: n }), armed(), withShard(0.14));
  assert.equal(r.allowed, true, r.reason);
});

t("sizing never exceeds the balance once the fee is counted", () => {
  for (const bal of [0.14, 0.5, 1, 2.5, 10]) {
    for (const cents of [3, 5, 12, 30, 60, 90]) {
      const n = maxContractsAllowed(cents, armed(), withShard(bal));
      if (n < 1) continue;
      const r = checkOrder(order({ limitCents: cents, contracts: n }), armed(), withShard(bal));
      assert.equal(r.allowed, true, `${n} at ${cents}c on $${bal}: ${r.reason}`);
      assert.ok(r.worstCase <= bal + 1e-9, `${r.worstCase} over balance ${bal}`);
    }
  }
});

t("an unknown shard balance does not block trading", () => {
  const r = checkOrder(order(), armed(), L);
  assert.equal(r.allowed, true);
});
