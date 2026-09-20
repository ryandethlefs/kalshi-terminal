// Pricing and fee math for Kalshi 15-minute up/down windows.
//
// Contract: resolves YES if the settlement price at the window's close is at or
// above the reference price locked at the window's open. So once the window is
// open the strike K is fixed, and fair value is arithmetic:
//
//   P(YES) = Phi( ( ln(S/K) - sigma^2 * tau / 2 ) / ( sigma * sqrt(tau) ) )
//
// There is no drift term. That is deliberate. Nobody reliably knows which way
// gold moves in the next eleven minutes, so assuming zero drift keeps this a
// measurement of what the contract is worth rather than a guess at direction.

// Abramowitz & Stegun 7.1.26, max error about 1.5e-7
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return sign * y;
}

export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Kalshi taker fee in dollars per contract at price p (dollars, 0..1). */
export const feePerContract = (p) => 0.07 * p * (1 - p);

/**
 * Whole-order taker fee, rounded up to the next cent.
 * The toFixed pass matters: 0.07 * 100 * 0.5 * 0.5 evaluates to
 * 1.7500000000000002 in binary floating point, which would round up to 1.76
 * and quietly overstate every cost estimate at the 50-cent price.
 */
export const orderFee = (p, contracts) => {
  const exact = Number((0.07 * contracts * p * (1 - p) * 100).toFixed(6));
  return Math.ceil(exact) / 100;
};

/**
 * Fair probability the window settles YES.
 * @param {number} spot   live settlement price
 * @param {number} ref    reference price locked at the window open
 * @param {number} sigma  realized volatility, per square-root-second
 * @param {number} tau    seconds left in the window
 */
export function fairYes(spot, ref, sigma, tau) {
  if (!(spot > 0) || !(ref > 0) || !(sigma > 0) || !(tau > 0)) return null;
  const sigTau = sigma * Math.sqrt(tau);
  const d = (Math.log(spot / ref) - 0.5 * sigma * sigma * tau) / sigTau;
  return clamp(normCdf(d), 0.0001, 0.9999);
}

/**
 * Expected value of buying one contract, net of the taker fee.
 * Returns cents per contract.
 */
export function edgeCents(winProb, ask) {
  if (ask == null || ask <= 0 || ask >= 1) return null;
  return (winProb - (ask + feePerContract(ask))) * 100;
}

/** Fraction of bankroll full Kelly would stake, using the all-in cost. */
export function kellyFraction(winProb, allInCost) {
  if (allInCost <= 0 || allInCost >= 1) return 0;
  return (winProb - allInCost) / (1 - allInCost);
}

/**
 * Realized volatility per square-root-second from a series of {t, price}
 * samples, where t is a millisecond timestamp.
 */
export function realizedVol(samples) {
  if (!samples || samples.length < 2) return null;
  let sumSq = 0;
  let sumDt = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const r = Math.log(samples[i].price / samples[i - 1].price);
    sumSq += r * r;
    sumDt += dt;
  }
  if (sumDt <= 0) return null;
  const sigma = Math.sqrt(sumSq / sumDt);
  return sigma > 0 ? sigma : null;
}
