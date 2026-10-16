require('dotenv').config();

const path = require('path');

const bool = (v, dflt = true) => (v === undefined ? dflt : String(v).toLowerCase() !== 'false');

const cfg = {
  // ---- chart ----
  symbol: process.env.SYMBOL || 'OANDA:XAUUSD',
  timeframe: process.env.TIMEFRAME || '5',
  historyRange: Number(process.env.HISTORY_RANGE) || 120,
  visibleCandles: Number(process.env.CHART_CANDLES) || 18,
  width: Number(process.env.CHART_WIDTH) || 1080,   // 9:16 portrait
  height: Number(process.env.CHART_HEIGHT) || 1920,
  drawProjection: bool(process.env.DRAW_PROJECTION, true),

  // ---- look & feel ----
  // 'light' = white background, hollow up candles / black down candles (TradingView light)
  // 'dark'  = dark background, teal/red candles
  theme: (process.env.THEME || 'light').toLowerCase(),
  // 0 = auto (3 decimals for gold-like prices, 5 for FX pairs)
  priceDecimals: Number(process.env.PRICE_DECIMALS) || 0,
  showGrid: bool(process.env.SHOW_GRID, true),
  // individual colour overrides, e.g. UP_BODY=#089981 for teal up candles
  colors: {
    upBody: process.env.UP_BODY || null,
    upBorder: process.env.UP_BORDER || null,
    downBody: process.env.DOWN_BODY || null,
    downBorder: process.env.DOWN_BORDER || null,
    box: process.env.BOX_COLOR || null,
  },

  // ---- MBOX (mirrors the Pine inputs) ----
  extendTo: Number(process.env.EXTEND_TO) || 10,
  boxStartIST: process.env.BOX_START_IST || '17:30',
  // Candle #4 (17:45-17:50) closes at 17:50 IST — that is the snapshot moment.
  sendIST: process.env.SEND_IST || '17:50',
  // Seconds to wait after that close before reading the feed, so candle #4's
  // final close is in the data instead of a stale last tick.
  settleSec: Number(process.env.SETTLE_SEC) || 6,

  // ---- schedule ----
  dailyEnabled: bool(process.env.DAILY_ENABLED, true),
  weekdaysOnly: bool(process.env.WEEKDAYS_ONLY, true),
  sendGraceMin: Number(process.env.SEND_GRACE_MIN) || 25, // fire if we wake up late
  waitForConfirmSec: Number(process.env.WAIT_FOR_CONFIRM_SEC) || 420,
  schedulerTickMs: (Number(process.env.SCHEDULER_TICK_SEC) || 20) * 1000,
  keepaliveIntervalMs: (Number(process.env.KEEPALIVE_INTERVAL_MIN) || 10) * 60 * 1000,
  keepaliveFromIST: process.env.KEEPALIVE_FROM_IST || '17:20',
  keepaliveToIST: process.env.KEEPALIVE_TO_IST || '18:00',

  // ---- telegram ----
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
  },
  notifyOnFailure: bool(process.env.NOTIFY_ON_FAILURE, true),

  // ---- hosting / triggers ----
  renderUrl: process.env.RENDER_URL || null,
  triggerKey: process.env.TRIGGER_KEY || null,

  // ---- local output ----
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, 'output'),
  savePng: bool(process.env.SAVE_PNG, false),
};

module.exports = cfg;
module.exports.bool = bool;
