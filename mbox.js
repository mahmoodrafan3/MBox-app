// ============================================================
// MBOX LOGIC — direct port of the Pine Script indicator
//
// Pine (indicator "MBOX", timeframe 5m, timezone Asia/Kolkata):
//   startCandle   = 17:30 IST  -> candle #1  (firstOpen, firstTime)
//   fourthCandle  = 17:45 IST  -> candle #4  (fourthClose, confirmed at 17:50)
//   boxTop        = math.max(firstOpen, fourthClose)
//   boxBottom     = math.min(firstOpen, fourthClose)
//   box           = left: 17:30, right: time_close of the newest candle
//                   while candleNumber <= extendTo
//   candleNumber  = floor(minutesFromStart / 5) + 1
//
// This module reproduces exactly that, from a candle array:
//   candle #1 = 17:30, #2 = 17:35, ... candleNumber => start + (n-1) * timeframe
// ============================================================

const IST_OFFSET_SEC = 5.5 * 3600; // Asia/Kolkata = UTC+05:30 (no DST)

/** IST calendar/time parts for an epoch (seconds) */
function istParts(epochSec) {
  const shifted = new Date((epochSec + IST_OFFSET_SEC) * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
    dateKey: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
  };
}

/** Current IST parts */
function nowIST() {
  return istParts(Math.floor(Date.now() / 1000));
}

/** IST date key of an epoch, e.g. '2026-10-15' */
function istDateKey(epochSec) {
  return istParts(epochSec).dateKey;
}

/** 'HH:MM' IST label of an epoch */
function istTimeLabel(epochSec) {
  const p = istParts(epochSec);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 'DD Mon HH:MM' IST label of an epoch */
function istDateTimeLabel(epochSec) {
  const p = istParts(epochSec);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(p.day).padStart(2, '0')} ${months[p.month - 1]} ${istTimeLabel(epochSec)}`;
}

/**
 * Epoch (seconds) of a given IST wall-clock time on a given IST date.
 * 17:30 IST -> 12:00 UTC on the same calendar day (offset is exactly +05:30).
 */
function istWallClockToEpoch(dateKey, hour, minute) {
  const [y, m, d] = dateKey.split('-').map(Number);
  // Shift the wall clock back by the offset to get the real UTC instant.
  const shifted = Date.UTC(y, m - 1, d, hour, minute, 0) - IST_OFFSET_SEC * 1000;
  return Math.floor(shifted / 1000);
}

/** Parse '17:30' -> { hour: 17, minute: 30 } */
function parseHHMM(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return fallback;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Find the candle whose bar-open time equals `epochSec` (small tolerance) */
function findCandleAt(candles, epochSec, toleranceSec = 1) {
  let best = null;
  for (const c of candles) {
    const delta = Math.abs(c.time - epochSec);
    if (delta <= toleranceSec && (!best || delta < Math.abs(best.time - epochSec))) best = c;
  }
  return best;
}

/**
 * Compute today's (or `dateIST`'s) MBOX levels from candles.
 *
 * @param {Array} candles            TradingView candles, oldest -> newest
 * @param {Object} [opts]
 * @param {string} [opts.dateIST]    IST date key, default: today in IST
 * @param {string} [opts.startIST]   Box start candle, default '17:30'
 * @param {number} [opts.extendTo]   Extend box to candle #N, default 10
 * @param {number} [opts.timeframe]  Timeframe in minutes, default 5
 * @param {number} [opts.nowSec]     "now" for confirmation checks, default Date.now()
 * @returns {Object} box result
 */
function computeMbox(candles, opts = {}) {
  const timeframe = Number(opts.timeframe) || 5;
  const extendTo = Math.max(4, Number(opts.extendTo) || 10);
  const startIST = opts.startIST || '17:30';
  const nowSec = opts.nowSec || Math.floor(Date.now() / 1000);
  const dateIST = opts.dateIST || istDateKey(nowSec);

  const start = parseHHMM(startIST, { hour: 17, minute: 30 });
  const startTime = istWallClockToEpoch(dateIST, start.hour, start.minute);
  const stepSec = timeframe * 60;

  // Candle #1 = 17:30, #4 = 17:45, #extendTo = start + (extendTo-1) * timeframe
  const firstTime = startTime;
  const fourthTime = startTime + 3 * stepSec;
  const lastBoxCandleTime = startTime + (extendTo - 1) * stepSec;
  const projectionRight = lastBoxCandleTime + stepSec; // close of candle #extendTo

  const base = {
    dateIST,
    symbol: opts.symbol || null,
    timeframe,
    startIST,
    extendTo,
    firstTime,
    fourthTime,
    lastBoxCandleTime,
    projectionRight,
    startTimeLabel: istTimeLabel(firstTime),
    fourthTimeLabel: istTimeLabel(fourthTime),
    lastBoxCandleLabel: istTimeLabel(lastBoxCandleTime),
  };

  const first = findCandleAt(candles, firstTime);

  // Weekend / holiday: the reference candle does not exist -> nothing to draw
  if (!first) {
    return { ...base, found: false, reason: `No ${base.startTimeLabel} IST candle for ${dateIST} (market closed or no data)` };
  }

  const fourth = findCandleAt(candles, fourthTime);
  if (!fourth) {
    return { ...base, found: false, reason: `Candle #1 found but no ${base.fourthTimeLabel} IST candle for ${dateIST}` };
  }

  // Pine only builds the box once candle #4 is CONFIRMED (barstate.isconfirmed),
  // i.e. once the clock is past its close at 17:50 IST.
  const fourthClosedAt = fourthTime + stepSec; // 17:50 IST
  const confirmed = nowSec >= fourthClosedAt;

  const firstOpen = first.open;
  // While candle #4 is still forming this is its live close — flagged by `confirmed`.
  const fourthClose = fourth.close;
  const top = Math.max(firstOpen, fourthClose);
  const bottom = Math.min(firstOpen, fourthClose);

  // Pine wires box.set_right() to time_close of every candle up to #extendTo.
  // At snapshot time only the already-closed candles exist, so the right edge
  // lands on the close of the last closed candle inside the box window.
  const boxWindowEnd = projectionRight; // exclusive: candles #1..#extendTo
  // A candle counts as closed only once its close time has passed as of the
  // snapshot moment — history that exists in the dataset but not yet in time
  // (e.g. a preview run) must not stretch the box.
  const isClosed = (c) => nowSec >= c.time + stepSec;
  const candlesInBox = candles
    .filter((c) => c.time >= firstTime && c.time < boxWindowEnd && c.time <= nowSec)
    .sort((a, b) => a.time - b.time);
  const closedInBox = candlesInBox.filter(isClosed);
  const lastProcessed = closedInBox.length ? closedInBox[closedInBox.length - 1] : fourth;
  const rightEdge = Math.max(fourthTime + stepSec, lastProcessed.time + stepSec);

  const height = top - bottom;
  const direction = fourthClose > firstOpen ? 'bullish' : fourthClose < firstOpen ? 'bearish' : 'neutral';

  return {
    ...base,
    found: true,
    confirmed,
    firstOpen,
    fourthClose,
    top,
    bottom,
    rightEdge,
    height,
    direction,
    candleCount: Math.min(extendTo, candlesInBox.length),
    firstCandle: first,
    fourthCandle: fourth,
    candlesInBox,
  };
}

module.exports = {
  computeMbox,
  findCandleAt,
  parseHHMM,
  istParts,
  nowIST,
  istDateKey,
  istTimeLabel,
  istDateTimeLabel,
  istWallClockToEpoch,
};
