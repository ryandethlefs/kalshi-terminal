import assert from "node:assert/strict";
import fs from "node:fs";
import { buildOrder, TradeLog, settlePosition, closeEarly, calibration } from "./lib/execution.js";
import { orderFee } from "./lib/model.js";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

t("buying YES lifts the bid side at the yes price", () => {
  const o = buildOrder({ ticker: "KXGOLD15M-A", side: "YES", limitCents: 45, contracts: 3 });
  assert.equal(o.side, "bid");
  assert.equal(o.price, "0.4500");
  assert.equal(o.count, "3.00");
});

t("buying NO becomes selling YES at the complement price", () => {
  // Buying NO at 62c is economically selling YES at 38c. If this ever returns
  // "bid", the bot places the opposite of every NO signal it generates.
  const o = buildOrder({ ticker: "X", side: "NO", limitCents: 62, contracts: 4 });
  assert.equal(o.side, "ask");
  assert.equal(o.price, "0.3800");
});

t("selling YES hits the ask at the yes price", () => {
  const o = buildOrder({ ticker: "X", side: "YES", limitCents: 70, contracts: 2, action: "sell" });
  assert.equal(o.side, "ask");
  assert.equal(o.price, "0.7000");
});

t("selling NO becomes buying YES at the complement price", () => {
  const o = buildOrder({ ticker: "X", side: "NO", limitCents: 30, contracts: 2, action: "sell" });
  assert.equal(o.side, "bid");
  assert.equal(o.price, "0.7000");
});

t("a buy and the sell that closes it land on opposite sides", () => {
  for (const side of ["YES", "NO"]) {
    const open = buildOrder({ ticker: "X", side, limitCents: 55, contracts: 1 });
    const close = buildOrder({ ticker: "X", side, limitCents: 55, contracts: 1, action: "sell" });
    assert.notEqual(open.side, close.side, `${side} open and close both went ${open.side}`);
    assert.equal(open.price, close.price);
  }
});

t("count and price are fixed-point strings, not numbers", () => {
  const o = buildOrder({ ticker: "X", side: "YES", limitCents: 7, contracts: 12 });
  assert.equal(typeof o.count, "string");
  assert.equal(typeof o.price, "string");
  assert.equal(o.price, "0.0700");
  assert.equal(o.count, "12.00");
});

t("orders never rest on the book", () => {
  const o = buildOrder({ ticker: "X", side: "YES", limitCents: 50, contracts: 1 });
  assert.equal(o.time_in_force, "immediate_or_cancel");
  assert.equal(o.post_only, false);
});

t("every order gets its own id", () => {
  const a = buildOrder({ ticker: "X", side: "YES", limitCents: 45, contracts: 1 });
  const b = buildOrder({ ticker: "X", side: "YES", limitCents: 45, contracts: 1 });
  assert.notEqual(a.client_order_id, b.client_order_id);
});

t("a winning settlement pays out minus the entry fee", () => {
  const pos = { ticker: "X", label: "Gold", side: "YES", contracts: 5, entry: 0.45, entryFee: 0.09 };
  const r = settlePosition(pos, { result: "yes" });
  assert.equal(r.won, true);
  assert.ok(Math.abs(r.pnl - (5 * 0.55 - 0.09)) < 1e-9, r.pnl);
});

t("a losing settlement costs the stake plus the fee", () => {
  const pos = { ticker: "X", label: "Gold", side: "YES", contracts: 5, entry: 0.45, entryFee: 0.09 };
  const r = settlePosition(pos, { result: "no" });
  assert.equal(r.won, false);
  assert.ok(Math.abs(r.pnl - (-5 * 0.45 - 0.09)) < 1e-9, r.pnl);
});

t("an unresolved market settles nothing", () => {
  const pos = { side: "YES", contracts: 5, entry: 0.45 };
  assert.equal(settlePosition(pos, { result: "" }), null);
  assert.equal(settlePosition(pos, {}), null);
});

t("a NO position wins when the window resolves no", () => {
  const pos = { side: "NO", contracts: 4, entry: 0.3, entryFee: 0.04 };
  const r = settlePosition(pos, { result: "no" });
  assert.equal(r.won, true);
  assert.ok(r.pnl > 0);
});

t("selling early nets both fees out of the result", () => {
  const pos = { ticker: "X", side: "YES", contracts: 10, entry: 0.4, entryFee: 0.17 };
  const exitFee = orderFee(0.6, 10);
  const r = closeEarly(pos, 0.6, exitFee);
  const gross = 10 * (0.6 - 0.4);
  assert.ok(r.pnl < gross, "fees were not deducted");
  assert.ok(Math.abs(r.pnl - (gross - exitFee - 0.17)) < 1e-9);
});

t("the trade log survives a restart", () => {
  const dir = "/tmp/tl-" + Date.now();
  const log = new TradeLog(dir);
  log.append({ kind: "close", ticker: "A", pnl: -1.2, won: false, predictedFair: 0.3 });
  log.append({ kind: "open", ticker: "B" });
  const reopened = new TradeLog(dir);
  assert.equal(reopened.all().length, 2);
  assert.equal(reopened.closed().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

t("a corrupt line does not take the whole log down", () => {
  const dir = "/tmp/tl2-" + Date.now();
  const log = new TradeLog(dir);
  log.append({ kind: "close", pnl: 1, won: true, predictedFair: 0.6 });
  fs.appendFileSync(log.file, "{ not json\n");
  log.append({ kind: "close", pnl: 2, won: true, predictedFair: 0.7 });
  assert.equal(log.closed().length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

t("calibration compares what the model said against what happened", () => {
  const trades = [
    { predictedFair: 0.62, won: true, pnl: 1 },
    { predictedFair: 0.65, won: false, pnl: -2 },
    { predictedFair: 0.68, won: true, pnl: 1 },
    { predictedFair: 0.22, won: false, pnl: -1 },
  ];
  const c = calibration(trades);
  assert.equal(c.trades, 4);
  assert.equal(c.wins, 2);
  assert.equal(c.totalPnl, -1);
  const b6 = c.buckets.find((b) => b.bucket === 0.6);
  assert.equal(b6.n, 3);
  assert.ok(Math.abs(b6.actuallyWon - 2 / 3) < 1e-9);
});

t("calibration returns null rather than fake numbers with no data", () => {
  assert.equal(calibration([]), null);
  assert.equal(calibration([{ pnl: 1 }]), null);
});

console.log(`\n${pass} execution tests passed\n`);

t("the shard index rides on every order", () => {
  const o = buildOrder({ ticker: "X", side: "YES", limitCents: 45, contracts: 2, exchangeIndex: 2 });
  assert.equal(o.exchange_index, 2);
});

t("a missing shard index does not silently become a wrong one", () => {
  // Defaulting to 0 is only safe because the server always passes the market's
  // own value. This pins the default so a regression is visible.
  const o = buildOrder({ ticker: "X", side: "YES", limitCents: 45, contracts: 2 });
  assert.equal(o.exchange_index, 0);
});
