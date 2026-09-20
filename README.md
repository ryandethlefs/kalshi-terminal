# 15-minute desk

A live terminal for Kalshi's 15-minute up/down commodity windows. It polls the
market every 5 seconds, prices each open window against the live settlement
feed, subtracts the trading fee, and tells you whether there is anything worth
acting on. It also watches positions you have open and says when the bid has
run ahead of what the position is actually worth.

## What it will not do

It will not predict which way gold moves. There is no drift term in the model,
on purpose. At a fifteen-minute horizon nobody credibly forecasts direction,
and pretending otherwise is how you lose money slowly.

What it does instead is measure. Once a window opens, its reference price is
locked, so the value of the contract becomes arithmetic: how far is the price
from the reference, how much time is left, and how much has this thing actually
been moving. That gives a fair value. Compare it to the book, subtract the fee,
and you have an edge number that is either big enough to act on or it isn't.

Most of the time it isn't. Expect to see "no trade" on most windows. That is
the tool working, not the tool failing. Kalshi's taker fee is `0.07 x P x (1-P)`
per contract, which peaks right at the 50-cent price where these markets live.
A gap has to clear roughly 1.75 cents round trip before it means anything.

None of this is financial advice, and the model can be wrong. Paper trade it on
the demo environment first.

## Setup

You need Node 20 or newer.

```bash
npm install
cp .env.example .env
```

Get your credentials from Kalshi under Account then API Keys. You will get a
key ID and a one-time download of a `.pem` private key. Put the `.pem` in this
folder and point `.env` at it.

```bash
# .env
KALSHI_KEY_ID=your-key-id-uuid
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem
KALSHI_BASE_URL=https://external-api.kalshi.com
PORT=8787
```

Then:

```bash
npm start
```

Open http://localhost:8787.

### Try it with fake data first

```bash
npm run demo
```

Demo mode invents windows and prices so you can see the interface work on a
weekend when the markets are dark. The numbers are made up. Do not trade off
them.

### Paper trade before you go live

Point `KALSHI_BASE_URL` at `https://external-api.demo.kalshi.co` and use demo
credentials. Same code path, no real money.

## Running the tests

```bash
npm test
```

33 tests. They cover the things that cost money if they are wrong: the fee
rounding, the fair value at and around the reference price, position sizing
limits, and every case where the answer should be "do not trade."

## Configuring it

`config.json` holds two blocks.

**series** is which markets to watch. Each needs the Kalshi series ticker and a
search string for the Pyth price feed that Kalshi settles against. Gold, silver,
copper, platinum and palladium are on by default. Nat gas and the stock indexes
are off because I could not verify their feed names. To turn one on, find its
feed first:

```
http://localhost:8787/api/pyth-search?q=WTI
```

Copy the symbol that comes back into `pythQuery`, set `enabled` to true, restart.

**engine** holds the rules. The ones worth knowing:

| Setting | Default | What it does |
| --- | --- | --- |
| `minEdgeCents` | 1.5 | How much edge, after fees, before it says buy |
| `exitEdgeCents` | 1.0 | How far the bid must run past fair before it says cash out |
| `maxSpreadCents` | 6 | Skip windows where the book is wider than this |
| `minSecondsLeft` | 20 | Stop acting this close to the close |
| `maxSecondsLeft` | 870 | Ignore the first 30 seconds of a window |
| `kellyFraction` | 0.25 | Quarter Kelly. Raising this is how people blow up |
| `maxContracts` | 200 | Hard ceiling on order size |

Raising `kellyFraction` above 0.25 is not recommended. Quarter Kelly already
assumes your probability estimate is right, and it is an estimate.

## If something does not work

`http://localhost:8787/api/debug` dumps the resolved price feeds, the last error
for each series, the reference price it found for each window, and the first raw
market object it received. It also writes that market to
`debug/sample-market.json`.

The one thing I could not verify without live credentials is which field Kalshi
puts the window's reference price in. The code tries three routes in order: a
strike field on the market, a number parsed out of the market text, and failing
both, the Pyth one-minute close at the window's open time. If the board shows
"reference price not identified yet," send me `debug/sample-market.json` and I
will pin the field exactly.

## How it is put together

```
server.js        request signing, polling loops, HTTP
lib/model.js     pricing, fees, volatility        (tested)
lib/board.js     the buy and exit rules           (tested)
public/index.html the terminal
config.json      which markets, which thresholds
```

The decision logic is pure functions with no network or clock in them, which is
why it can be tested properly. `server.js` gathers state and hands it over.

## Rate limits

Six series at one request each per 5 seconds is about 1.2 requests a second.
That fits in Kalshi's basic tier. If you enable everything, raise
`kalshiPollMs` or you will start getting 429s.

---

# The bot

## Arming it

The bot runs in every mode, but it only sends orders when you start the server
with `--live`:

```bash
npm start     # dry run: same logic, logs the order it would place, sends nothing
npm run live  # real orders against real money
```

`--live` and `--demo` together are refused. Placing real orders against invented
prices is not a mistake worth leaving available.

There is a **Stop trading** button on the page. It halts the bot for the rest of
the session and cannot be undone without a restart.

## Before you arm it: confirm the order shape

I could not verify Kalshi's current order schema, because the market data
endpoint has already moved from cents to a `_dollars` shape and the order
endpoint may have moved with it. The payload sends both forms, but confirm it
against a real response first:

```bash
curl -X POST http://localhost:8787/api/probe-order
```

That sends one contract at 1 cent, which will not fill. Read the response. If it
comes back with an error about the price field, tell me what it says and I will
correct it. Do not skip this.

## The limits

In `config.json` under `bot`:

| Setting | Default | What it does |
| --- | --- | --- |
| `bankroll` | 50 | What the sizing math assumes you have |
| `dailyLossLimit` | 5 | Realized losses that halt trading for the day |
| `maxStakePerTrade` | 2.5 | Most that can be at risk in one window |
| `maxOpenPositions` | 2 | Windows held at once |
| `maxTotalExposure` | 5 | Total money at risk across all open positions |
| `maxDataAgeSec` | 10 | Refuse to trade on a price feed older than this |

An order is refused if it breaks any of them. It is also refused if its worst
case would push the day past the stop, so the limit cannot be overshot by a
trade that was already in flight.

At these settings, three losing trades hit the daily stop.

## The log

Everything lands in `log/trades.jsonl`: every signal, whether it was acted on or
blocked and why, every order, every fill, every settlement. It survives restarts.

This file, not your balance, is what tells you whether the strategy works. Each
trade records what the model believed at entry, so the record can be scored
against what actually happened. `/api/log` returns the last 200 entries.

At this stake a good trade makes about 15 cents, and the noise per trade is
roughly 17 times the size of the signal. It takes on the order of a thousand
trades before a real edge is distinguishable from luck. Read the calibration,
not the balance.
