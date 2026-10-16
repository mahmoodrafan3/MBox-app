# MBOX Alert — daily TradingView chart photo to Telegram

Every trading day at **5:50 PM IST — the close of candle #4** — this service posts a
portrait (9:16) candlestick chart photo of your MBOX setup to a Telegram channel: free
TradingView candle data, the purple MBOX box drawn on top, rendered as a PNG.

No TradingView subscription, no TradingView API key, no Python, no headless browser.

```
┌────────────────────────┐      ┌──────────────────────────┐      ┌─────────────────┐
│ GitHub Actions  (cron) │ ───► │ Render free Web Service  │ ───► │ Telegram channel│
│ 12:20 UTC = 5:50 PM IST│ ping │ fetch candles → MBOX box │ photo│  5:50 PM IST    │
└────────────────────────┘      │ → render PNG (Node)      │      └─────────────────┘
                                └────────────┬─────────────┘
                                             │ websocket (free)
                                   ┌─────────▼──────────┐
                                   │ TradingView feed   │
                                   └────────────────────┘
```

---

## What exactly gets drawn

The box is a faithful port of your Pine indicator — same rules, same numbers:

| Pine (MBOX) | This service |
|---|---|
| `startCandle` = 17:30 IST → candle #1 (`firstOpen`) | candle whose bar opens 17:30 IST |
| `fourthCandle` = 17:45 IST → candle #4 (`fourthClose`) | candle whose bar opens 17:45 IST |
| `boxTop = math.max(firstOpen, fourthClose)` | same |
| `boxBottom = math.min(firstOpen, fourthClose)` | same |
| `box.new(left = 17:30, right = time_close)` | box spans 17:30 → close of candle #4 (17:50) |
| `box.set_right(...)` while `candleNumber <= extendTo` | dashed projection out to candle `EXTEND_TO` (#10 → 18:20) |
| `color.new(color.purple, 75)` + purple border | `rgba(156,39,176,.26)` fill + `#ab47bc` border |
| `timezone = "Asia/Kolkata"` | IST clock, `+05:30`, both for the window and the scheduler |

## Look & feel

Default is the TradingView **light** theme: white background, hollow (white) up candles,
solid black down candles and grey price labels with the instrument's precision
(`4,132.000`, `4,130.000`, … on a round 2.000 step).

The MBOX box is translucent purple, with a **minimal range chip on its left** holding
just the box height in price units (`5.650`), and purple price tags on the axis marking
the box top and bottom:

| Variable | Default | Description |
|---|---|---|
| `THEME` | `light` | `light` or `dark` |
| `PRICE_DECIMALS` | `0` | `0` = auto (3 for gold-like prices, 5 for FX pairs) |
| `SHOW_GRID` | `true` | faint grid; set `false` for a completely clean background |
| `UP_BODY` / `UP_BORDER` | `#ffffff` / `#000000` | up candle fill + outline (hollow look) |
| `DOWN_BODY` / `DOWN_BORDER` | `#000000` / `#000000` | down candle fill + outline |
| `BOX_COLOR` | `#ab47bc` | MBOX box border, range chip and axis tags |

Want the classic teal/red candles instead of the monochrome look? Set
`UP_BODY=#089981`, `UP_BORDER=#089981`, `DOWN_BODY=#f23645`, `DOWN_BORDER=#f23645`.
Setting `UP_BODY` to the background colour (`#ffffff`) gives fully hollow candles.

**Timing** — candle #4 (17:45–17:50 IST) closes at 17:50, and Pine creates the box on
that bar's close (`barstate.isconfirmed`). The photo is therefore taken **at 5:50 PM**,
with a short `SETTLE_SEC` (6 s) pause so the feed has the candle's *final* close instead
of the last mid-candle tick. If the job is triggered earlier it waits for that close and
re-fetches rather than drawing a half-formed candle.

---

## Why this design (the "mplfinance vs. screenshot" question)

| Approach | Verdict |
|---|---|
| **Python + mplfinance in the Node backend** | Works locally, but a Render Node web service has no Python/pandas/matplotlib. You'd ship a second runtime (~150 MB) into a 512 MB free instance and slow every cold start. |
| **Headless Chromium screenshot of TradingView** | Looks authentic, but ~400 MB of browser on the free tier (OOM-prone), slow cold starts, and TradingView will not draw *your* MBOX box — you'd have to overlay it anyway. |
| **Render the chart in Node (this repo)** | ~1.5 s to fetch + ~0.6 s to render, few MB of dependencies, no browser, no second runtime, and the box is guaranteed to match your Pine logic. |

The chart is drawn with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas)
(prebuilt Skia bindings — no build toolchain on Render) and fonts are bundled
(`assets/fonts/Inter-*.ttf`) so labels render even on containers without system fonts.

The default palette is the TradingView **light** look — white background, hollow up
candles, solid black down candles, grey three-decimal price labels on round steps — and
every colour can be swapped with env vars; see [Look & feel](#look--feel).

---

## Quick start (local)

```bash
npm install
cp .env.example .env          # optional: fill in Telegram creds
npm start                     # server + daily scheduler
```

Render a chart right now without sending anything:

```bash
npm run preview                                  # today, saved to output/
node scripts/snapshot.js --no-send --save        # same
node scripts/snapshot.js --date=2026-10-15 --now-ist=17:50 --no-send --save
```

`--now-ist=17:50` reproduces exactly what the 5:50 PM job sees on that date
(box at candle #4, dashed projection to #10) — handy for verifying a change.

Send it for real (needs Telegram creds in `.env`):

```bash
node scripts/snapshot.js
```

---

## Telegram setup

1. Talk to **@BotFather** → `/newbot` → copy the token.
2. **For a channel:** add the bot as an **administrator** of the channel, then use
   `TELEGRAM_CHAT_ID=@your_channel` (public) or the numeric `-100…` id (private).
   Posting is done with `sendPhoto`, so the bot needs post permission.
3. For a private chat/group, get your id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `chat.id`.

---

## Deploy on Render (free) + GitHub Actions

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "MBOX daily chart photo"
git remote add origin https://github.com/YOUR_USERNAME/mbox-alert.git
git push -u origin main
```

### 2. Create the Render Web Service

| Setting | Value |
|---|---|
| Type | **Web Service** |
| Environment | **Node** |
| Build Command | `npm install` |
| Start Command | `node index.js` |
| Plan | **Free** |

### 3. Render environment variables

| Variable | Value |
|---|---|
| `SYMBOL` | `OANDA:XAUUSD` |
| `TIMEFRAME` | `5` |
| `EXTEND_TO` | `10` |
| `SEND_IST` | `17:50` |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `TELEGRAM_CHAT_ID` | `@your_channel` or `-100…` |
| `TRIGGER_KEY` | a random secret |
| `RENDER_URL` | `https://your-app.onrender.com/health` |

### 4. Wake it up every day (GitHub Actions)

The free tier sleeps after ~15 minutes idle, so something external has to wake it.
`.github/workflows/mbox-daily.yml` already does that:

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**
2. Name `MBOX_TRIGGER_URL`, value
   `https://your-app.onrender.com/trigger?key=YOUR_TRIGGER_KEY`
3. It fires at **12:20 UTC (17:50 IST)** with a retry at **12:25 UTC**, Mon–Fri.
   `curl --max-time 180` waits through a Render cold start (~60 s).

<details>
<summary>Prefer cron-job.org?</summary>

Create a daily job (Mon–Fri) at **12:20 UTC** hitting
`https://your-app.onrender.com/trigger?key=YOUR_TRIGGER_KEY`.
Note cron-job.org times out at 30 s and a Render cold start can take ~60 s, which is
exactly why the GitHub Actions path is the default here. Use both if you like — the
second trigger is a no-op once the day's snapshot has been sent.
</details>

### 5. Three layers of reliability

| Layer | What it does |
|---|---|
| GitHub Actions (or cron-job.org) | wakes the sleeping service and calls `/trigger` |
| Internal scheduler | if the service is already awake, sends at 17:50 IST (+25 min grace if it woke up late) |
| Internal keepalive | self-pings between 17:20–18:00 IST only, to protect free-tier hours |

Sends are idempotent per IST day: a second trigger is answered with
`"skipped": true` instead of posting a duplicate chart.

---

## HTTP endpoints

| Route | Purpose |
|---|---|
| `/health` | `OK` — Render health check / keepalive ping |
| `/status` | config, last result, per-day send bookkeeping |
| `/trigger` | build + send now. `?date=YYYY-MM-DD`, `?force=1`, `?send=false`, `?key=SECRET` |
| `/preview.png` | view the chart in a browser without posting (add `?send=1` to also post) |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SYMBOL` | `OANDA:XAUUSD` | TradingView symbol (`exchange:pair`) |
| `TIMEFRAME` | `5` | candle minutes (the Pine script assumes 5m) |
| `EXTEND_TO` | `10` | Pine `extendTo` — last candle the box reaches |
| `BOX_START_IST` | `17:30` | Pine `startCandle` (candle #1) |
| `SEND_IST` | `17:50` | daily send time, IST (candle #4 close) |
| `SETTLE_SEC` | `6` | pause after that close so the final tick is in the data |
| `CHART_CANDLES` | `18` | candles drawn on the image |
| `CHART_WIDTH` / `CHART_HEIGHT` | `1080` / `1920` | canvas size (9:16 portrait) |
| `THEME` | `light` | `light` (white, hollow/black candles) or `dark` |
| `PRICE_DECIMALS` | `0` | `0` = auto (3 for gold-like prices, 5 for FX) |
| `UP_BODY` / `UP_BORDER` / `DOWN_BODY` / `DOWN_BORDER` | theme colours | optional candle colour overrides |
| `BOX_COLOR` | `#ab47bc` | MBOX box / chip / tag colour |
| `HISTORY_RANGE` | `120` | minimum candles fetched (auto-raised for backfills) |
| `DRAW_PROJECTION` | `true` | draw the dashed box extension to `EXTEND_TO` |
| `DAILY_ENABLED` | `true` | enable the internal scheduler |
| `WEEKDAYS_ONLY` | `true` | Mon–Fri only |
| `SEND_GRACE_MIN` | `25` | still send if the service wakes up late |
| `WAIT_FOR_CONFIRM_SEC` | `420` | max wait for candle #4 to close if triggered early |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | where the photo goes |
| `NOTIFY_ON_FAILURE` | `true` | Telegram text notice when a box cannot be built |
| `RENDER_URL` | — | enables the send-window keepalive |
| `TRIGGER_KEY` | — | shared secret required by `/trigger` |
| `KEEPALIVE_FROM_IST` / `KEEPALIVE_TO_IST` | `17:20` / `18:00` | keepalive window |
| `SAVE_PNG`, `OUTPUT_DIR`, `PORT` | `false`, `./output`, `3000` | local options |

---

## Notes

* **Weekends/holidays** — if the 17:30 IST candle does not exist (market closed), no
  chart is posted; with `NOTIFY_ON_FAILURE=true` you get a short text notice instead of
  silence.
* **Timing drift** — GitHub's cron is best-effort and can run minutes late. Box levels
  come from closed candles, so a late run still posts the correct MBOX, with the box
  extended further to the right (exactly what Pine would show at that moment).
* **Changing instrument** — set `SYMBOL` (e.g. `OANDA:EURUSD`, `BINANCE:BTCUSDT`).
  Price formatting adapts automatically.
* **Fonts** — Inter, bundled under the SIL Open Font License.
* Not affiliated with TradingView; data comes from TradingView's public chart feed.

MIT.
