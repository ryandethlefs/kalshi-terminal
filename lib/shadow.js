// Shadow scoring.
//
// The bot only learns from windows it trades, and with a high conviction floor
// that is a handful a day. But it watches every window. This records what the
// model believed about each one at a fixed moment, then what actually happened,
// whether or not money was involved.
//
// Roughly 96 windows a day across two series instead of a few trades, at no
// cost and no risk. It is the only cheap way to find out whether the fair
// values predict anything, which is the question everything else rests on.

/** Bucket a probability into a 5-point band for calibration. */
export function band(p) {
  if (!(p >= 0 && p <= 1)) return null;
  return Math.min(0.95, Math.floor(p * 20) / 20);
}

/**
 * Score a set of snapshots against their outcomes.
 *
 * A snapshot is {fair, marketMid, result} where result is "yes" or "no".
 * Returns per-band counts plus, crucially, the same scoring applied to the
 * market's own price. If the model cannot beat the market's number, there is
 * no edge and no parameter will create one.
 */
export function score(snapshots) {
  const scored = snapshots.filter(
    (s) =>
      typeof s.fair === "number" &&
      (s.result === "yes" || s.result === "no")
  );
  if (scored.length === 0) return null;

  const buckets = new Map();
  for (const s of scored) {
    const b = band(s.fair);
    if (b == null) continue;
    const cur = buckets.get(b) || { n: 0, claimed: 0, happened: 0, marketSaid: 0 };
    cur.n += 1;
    cur.claimed += s.fair;
    cur.happened += s.result === "yes" ? 1 : 0;
    cur.marketSaid += typeof s.marketMid === "number" ? s.marketMid : 0;
    buckets.set(b, cur);
  }

  // Brier score: mean squared error of the probability. Lower is better.
  // Comparing the model's against the market's is the whole test.
  const brier = (pick) =>
    scored.reduce((sum, s) => {
      const p = pick(s);
      if (typeof p !== "number") return sum;
      const actual = s.result === "yes" ? 1 : 0;
      return sum + (p - actual) ** 2;
    }, 0) / scored.length;

  const withMarket = scored.filter((s) => typeof s.marketMid === "number");

  // Paired per-window differences. Comparing two Brier scores on the same
  // windows is a paired test, so the spread of the differences is what sets
  // the error bar, not the spread of the scores themselves.
  const diffs = withMarket.map((s) => {
    const actual = s.result === "yes" ? 1 : 0;
    return (s.marketMid - actual) ** 2 - (s.fair - actual) ** 2;
  });
  const meanDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  const sdDiff =
    diffs.length > 1
      ? Math.sqrt(
          diffs.reduce((sum, d) => sum + (d - meanDiff) ** 2, 0) / (diffs.length - 1)
        )
      : null;
  const stdErr = sdDiff != null && diffs.length ? sdDiff / Math.sqrt(diffs.length) : null;

  return {
    windows: scored.length,
    modelBrier: brier((s) => s.fair),
    marketBrier: withMarket.length ? brier((s) => s.marketMid) : null,
    comparable: withMarket.length,
    meanDiff,
    stdErr,
    bands: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, v]) => ({
        band: b,
        n: v.n,
        modelSaid: v.claimed / v.n,
        marketSaid: v.marketSaid / v.n,
        actuallyHappened: v.happened / v.n,
      })),
  };
}

/**
 * Is the model beating the market, and is the sample big enough to say so?
 *
 * The standard error on a Brier difference is roughly 1/(2*sqrt(n)) for
 * probabilities in this range, so anything under a couple of hundred windows
 * cannot separate a real edge from noise. Saying so plainly matters more than
 * producing a verdict.
 */
export function verdict(s) {
  if (!s || s.marketBrier == null || s.stdErr == null) {
    return { text: "Not enough data yet", sure: false };
  }
  const diff = s.meanDiff;             // positive means the model is better
  const sure = Math.abs(diff) > 2 * s.stdErr;
  if (!sure) {
    // How many windows would it take at this effect size? Scales as 1/n.
    const sd = s.stdErr * Math.sqrt(s.comparable);
    const needed = diff === 0 ? null : Math.ceil(((2 * sd) / Math.abs(diff)) ** 2);
    return {
      text: needed
        ? `Too close to call after ${s.comparable} windows. About ${needed} would settle it at this effect size.`
        : `Dead even after ${s.comparable} windows.`,
      sure: false,
      diff,
    };
  }
  return {
    text: diff > 0
      ? `Model is beating the market's own price over ${s.comparable} windows.`
      : `Market's price is beating the model over ${s.comparable} windows. There is no edge here.`,
    sure: true,
    diff,
  };
}
