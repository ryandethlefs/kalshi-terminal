# AGENTS.md

Context for any agent working on this repo. Most of what follows was learned by
losing money, so please read it before changing execution or risk code.

## What this is

A local Node server that watches Kalshi's 15-minute commodity and crypto
windows, prices them, and optionally trades them. `npm start` is dry run,
`npm run live` sends real orders, `npm run demo` invents data.

## Hard-won facts about the Kalshi API

These cost hours each. None are obvious from the docs.

- **Orders go to `POST /portfolio/events/orders`.** The older
  `/portfolio/orders` returns 410.
- **It is a single YES book.** Buying NO is `side: "ask"` at `1 - price`, not
  `side: "bid"`. Getting this backwards silently trades the wrong direction.
- **Counts and prices are strings**: `count: "3.00"`, `price: "0.8100"`.
- **Commodities live on `exchange_index: 2`**, a separate shard with separate
  collateral. Omitting it defaults to shard 0 and fails with "Exchange user not
  found". Funds must be transferred to the shard before anything fills.
- **The request signature covers the path without its query string.** Passing
  `/portfolio/positions?exchange_index=2` as the path signs the query too and
  returns 401 `INCORRECT_API_KEY_SIGNATURE`, which reads like a credentials
  problem and is not. `kalshiGet` now strips this defensively.
- **An IOC order returns 201 whether or not it filled.** Always read
  `fill_count`. Treating 201 as a fill invents positions that do not exist.
- **Settlement values are on the market record** as `floor_strike` and
  `expiration_value`. Do not parse them out of the market title: an early
  version read "Silver on Sep 17" and took 17 as the reference price.

## Two different settlement mechanics

- **Metals** settle on a single closing print. Priced in `lib/model.js`.
- **Crypto** settle on the **mean of 60 index prices** across the final minute,
  against a reference that is itself a 60-second mean. Priced in
  `lib/crypto.js`. This is not a detail: averaging suppresses variance, so at
  30 seconds left the correct model says 95c where a point-close model says
  69c. Once samples bank they cannot move, which is the only structural edge
  this system has.

## Bugs that have already happened

Do not reintroduce these.

1. **Volatility gated on sample count, not elapsed time.** 30 samples at 2s
   intervals is 60 seconds of history, which cannot describe a 15-minute
   window. Sigma came out ~2x too low and manufactured fake edge. Use
   `minVolSpanSec`.
2. **The daily stop counted dry-run and unfilled trades.** Imaginary profits
   offset real losses and the limit never fired. Only `live === true` counts.
3. **The record counted only settled trades.** Cut trades carry a P&L but no
   win flag, so the display read "13/13" while the account was down.
4. **IOC exits during a fast move.** An exit priced at the last seen bid is
   cancelled by any tick against it, retries two seconds later against a worse
   price, and repeats. A 55% stop produced a 98% loss that way. Exits now
   concede a few cents and widen on each failure; a resting stop is the proper
   fix.
5. **Stale windows.** Kalshi keeps listing a window after it closes. Without
   filtering on `close_time > now` the bot locks onto a dead market forever.
6. **Blind find-and-replace patching.** Twice an edit matched in two places, or
   in none, and shipped broken. Verify the result, do not assume the patch did
   what was intended.

## Guards, and when they are wrong

`lib/board.js` refuses edges above `maxEdgeCents` and fair values pinned at the
clamp. Both exist because on metals those signals mean the volatility estimate
has broken. On a settlement average with most samples banked they mean the
opposite: the model is doing arithmetic on fixed values, not extrapolating. The
guards therefore relax above 30 banked samples and apply in full below it.

## What has and has not been established

- Over 104 scored metals windows the model and the market were a **dead heat**
  on Brier score, well inside noise. No edge has been demonstrated.
- In the 80%-plus band, 29 of 31 windows came in against the model's claimed
  91%. Suggestive, far too small to rely on.
- The model is **badly overconfident at the low extreme**: it said 1.4% on 18
  windows where 11% happened.
- Every live loss so far came from the model being **more confident than the
  market** and being wrong.

`/api/calibration` scores every window whether traded or not. `/api/exits`
measures whether cutting early beats holding. Both need hundreds of samples
before they mean anything. Prefer adding to them over tuning parameters on
small samples, which has already produced two reversed conclusions.

## Conventions

- Every module has a test file; run `npm test` before proposing changes.
- Comments explain why, especially where the reason is a past failure.
- Risk limits live in `config.json` under `bot`, with `bot.metals` and
  `bot.crypto` overriding per group. Position slots are counted per group so
  crypto, which runs 24/7, cannot starve metals.
- Never commit `.env` or `*.pem`.
