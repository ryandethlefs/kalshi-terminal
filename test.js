import assert from "node:assert/strict";
import {
  normCdf, feePerContract, orderFee, fairYes, edgeCents, kellyFraction, realizedVol,
} from "./lib/model.js";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

t("normal CDF anchors", () => {
  near(normCdf(0), 0.5);
  near(normCdf(1), 0.8413, 2e-3);
  near(normCdf(-1.96), 0.025, 2e-3);
});

t("fee peaks at 50 cents and decays to the tails", () => {
  near(feePerContract(0.5), 0.0175, 1e-6);
  near(feePerContract(0.1), 0.0063, 1e-6);
  near(feePerContract(0.9), 0.0063, 1e-6);
  assert.ok(feePerContract(0.5) > feePerContract(0.25));
});

t("order fee rounds up to the next cent", () => {
  // 0.07 * 62 * 0.40 * 0.60 = 1.0416 -> 1.05
  near(orderFee(0.40, 62), 1.05, 1e-9);
  // 0.07 * 100 * 0.50 * 0.50 = 1.75 exactly
  near(orderFee(0.50, 100), 1.75, 1e-9);
  // 0.07 * 100 * 0.10 * 0.90 = 0.63
  near(orderFee(0.10, 100), 0.63, 1e-9);
});

t("fair value: at the reference with time left it is a coin flip", () => {
  const p = fairYes(4200, 4200, 0.00002, 400);
  near(p, 0.5, 5e-3);
});

t("fair value: above the reference is above 50, below is below", () => {
  const up = fairYes(4205, 4200, 0.00002, 400);
  const down = fairYes(4195, 4200, 0.00002, 400);
  assert.ok(up > 0.5 && down < 0.5, `${up} / ${down}`);
  near(up + down, 1.0, 0.02);
});

t("fair value: less time left pushes toward certainty", () => {
  const far = fairYes(4205, 4200, 0.00002, 800);
  const near_ = fairYes(4205, 4200, 0.00002, 60);
  assert.ok(near_ > far, `${near_} should exceed ${far}`);
});

t("fair value: missing inputs return null", () => {
  assert.equal(fairYes(0, 4200, 0.00002, 400), null);
  assert.equal(fairYes(4200, 4200, null, 400), null);
  assert.equal(fairYes(4200, 4200, 0.00002, -5), null);
});

t("edge: a true coin flip bought at 50 cents loses the fee", () => {
  near(edgeCents(0.5, 0.5), -1.75, 1e-6);
});

t("edge: a real gap clears the fee", () => {
  // fair 62c, ask 55c, fee 1.73c -> about 5.27c of edge
  near(edgeCents(0.62, 0.55), 5.27, 0.02);
});

t("edge: refuses prices outside the book range", () => {
  assert.equal(edgeCents(0.6, 0), null);
  assert.equal(edgeCents(0.6, 1), null);
});

t("kelly: no edge means no stake", () => {
  assert.ok(kellyFraction(0.5, 0.5175) < 0);
  near(kellyFraction(0.62, 0.5673), 0.1218, 1e-3);
});

t("realized vol: flat price gives no volatility", () => {
  const flat = Array.from({ length: 50 }, (_, i) => ({ t: i * 5000, price: 100 }));
  assert.equal(realizedVol(flat), null);
});

t("realized vol: recovers a known sigma", () => {
  // Build a walk with a known per-step log return size.
  const step = 0.0001;
  const dtSec = 5;
  const samples = [{ t: 0, price: 100 }];
  for (let i = 1; i < 400; i++) {
    const r = i % 2 === 0 ? step : -step;
    samples.push({ t: i * dtSec * 1000, price: samples[i - 1].price * Math.exp(r) });
  }
  const sigma = realizedVol(samples);
  near(sigma, step / Math.sqrt(dtSec), 1e-6);
});

t("end to end: a 4 dollar gap on gold with 5 minutes left", () => {
  const sigma = 0.000015;           // per sqrt-second
  const p = fairYes(4204, 4200, sigma, 300);
  const ask = 0.70;
  const ev = edgeCents(p, ask);
  assert.ok(p > 0.9, `fair ${p}`);
  assert.ok(ev > 0, `edge ${ev}`);
  const f = kellyFraction(p, ask + feePerContract(ask));
  assert.ok(f > 0 && f < 1, `kelly ${f}`);
});

console.log(`\n${pass} tests passed\n`);
