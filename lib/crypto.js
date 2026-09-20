// Crypto 15-minute windows settle differently from metals, and the difference
// is the whole reason this file exists.
//
// A metals window settles on a single 1-minute candle close. A crypto window
// settles on the MEAN of 60 index prices, sampled once per second across the
// final minute. The reference it is compared against is itself the mean of the
// 60 seconds before the window opened.
//
// That changes the maths in a way that matters. Averaging suppresses variance,
// and once the final minute starts, part of the settlement value is already
// fixed and can never move. A model that prices these as if a single closing
// print decides them will systematically overstate how uncertain they are.

import { normCdf, clamp } from "./model.js";

export const SETTLE_SAMPLES = 60;

/**
 * Standard deviation of the eventual settlement average, in price units.
 *
 * Three regimes:
 *
 *   Before the final minute. The price must first wander for `u` seconds to
 *   reach the averaging window, then be averaged across it. The variance of a
 *   mean of a Brownian path over n steps is sigma^2 * n/3, not sigma^2 * n, so
 *   the averaging is worth roughly two thirds of that last minute's variance.
 *
 *   Inside the final minute. Some samples are already banked. Only the
 *   remaining ones can move, and they are diluted by 60.
 *
 *   After it. Nothing can move.
 *
 * @param {number} sigma  volatility per square-root-second
 * @param {number} tau    seconds until the window closes
 */
export function settlementSigma(sigma, tau) {
  if (!(sigma > 0)) return null;
  if (tau <= 0) return 0;

  if (tau >= SETTLE_SAMPLES) {
    const u = tau - SETTLE_SAMPLES;             // seconds before averaging starts
    return sigma * Math.sqrt(u + SETTLE_SAMPLES / 3);
  }

  const remaining = Math.max(0, Math.round(tau));
  if (remaining === 0) return 0;
  // Only `remaining` of the 60 samples are still unknown, and each carries
  // 1/60 of the final average.
  return (remaining / SETTLE_SAMPLES) * sigma * Math.sqrt(remaining / 3);
}

/**
 * Expected settlement value given what is already banked.
 *
 * Outside the final minute this is just the current price. Inside it, the
 * samples already taken are fixed, so the expectation is a blend of what has
 * happened and what the price is now.
 *
 * @param {number} spot        current price
 * @param {number} tau         seconds until close
 * @param {number[]} banked    samples already collected this final minute
 */
export function expectedSettlement(spot, tau, banked = []) {
  if (tau >= SETTLE_SAMPLES || banked.length === 0) return spot;
  const remaining = Math.max(0, SETTLE_SAMPLES - banked.length);
  const bankedSum = banked.reduce((a, b) => a + b, 0);
  return (bankedSum + remaining * spot) / SETTLE_SAMPLES;
}

/**
 * Probability a crypto window settles YES.
 *
 * YES means the settlement average is at or above the reference. Kalshi's
 * rules put an exact tie on the YES side.
 */
export function fairYesAveraged(spot, ref, sigma, tau, banked = []) {
  if (!(spot > 0) || !(ref > 0) || !(sigma > 0)) return null;
  if (tau <= 0) return null;

  const sd = settlementSigma(sigma, tau);
  const centre = expectedSettlement(spot, tau, banked);
  if (sd === 0 || !(sd > 0)) return centre >= ref ? 0.9999 : 0.0001;

  // sigma is a proportional volatility, so the spread scales with price.
  const sdPrice = sd * spot;
  return clamp(normCdf((centre - ref) / sdPrice), 0.0001, 0.9999);
}

/**
 * How much less uncertain the averaged model is than a naive point-close one.
 * Above 1 means the naive model overstates the spread, which is where any
 * mispricing would live.
 */
export function averagingAdvantage(sigma, tau) {
  if (!(sigma > 0) || tau <= 0) return null;
  const naive = sigma * Math.sqrt(tau);
  const real = settlementSigma(sigma, tau);
  if (!(real > 0)) return Infinity;
  return naive / real;
}
