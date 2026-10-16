// ============================================================
// CHART RENDERER — TradingView-style candles + MBOX box -> PNG
//
// Portrait 9:16 by default (1080x1920), sized for a phone screen.
// Pure Node, no browser: @napi-rs/canvas (prebuilt Skia bindings, no
// build toolchain on Render). A bundled Inter TTF is registered so
// axis labels render even on fontless containers.
//
// Themes: 'light' (white background, hollow up candles, black down
// candles — the TradingView light look) and 'dark'. Every candle
// colour can also be overridden individually through the env.
//
// The price axis uses "nice" round steps (1/2/2.5/5 x 10^n) and the
// instrument's precision, so labels read 4,132.000 / 4,130.000 / ...
// ============================================================

const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const cfg = require('./config');

const BASE_WIDTH = 1080; // reference width the layout was designed against

// ---------- THEMES ----------
const THEMES = {
  light: {
    bg: '#ffffff',
    panel: '#ffffff',
    border: '#e0e3eb',
    grid: '#f2f4f8',
    text: '#131722',
    dim: '#b2b5be',
    upBody: '#ffffff',   // hollow candle
    upBorder: '#000000',
    downBody: '#000000', // solid candle
    downBorder: '#000000',
    boxFill: 'rgba(156, 39, 176, 0.24)',
    boxBorder: '#ab47bc',
    boxLabel: '#ab47bc',
    tagText: '#ffffff',
  },
  dark: {
    bg: '#131722',
    panel: '#161a25',
    border: '#2a2e39',
    grid: '#1e222d',
    text: '#d1d4dc',
    dim: '#787b86',
    upBody: '#26a69a',
    upBorder: '#26a69a',
    downBody: '#ef5350',
    downBorder: '#ef5350',
    boxFill: 'rgba(156, 39, 176, 0.26)', // color.purple @ 75 transparency
    boxBorder: '#ab47bc',
    boxLabel: '#ce93d8',
    tagText: '#ffffff',
  },
};

function theme() {
  const base = THEMES[cfg.theme] || THEMES.light;
  const T = { ...base };
  // Optional per-colour overrides (e.g. teal up candles instead of hollow)
  if (cfg.colors.upBody) T.upBody = cfg.colors.upBody;
  if (cfg.colors.upBorder) T.upBorder = cfg.colors.upBorder;
  if (cfg.colors.downBody) T.downBody = cfg.colors.downBody;
  if (cfg.colors.downBorder) T.downBorder = cfg.colors.downBorder;
  if (cfg.colors.box) {
    T.boxBorder = cfg.colors.box;
    T.boxLabel = cfg.colors.box;
  }
  return T;
}

const FONT_FAMILY = (() => {
  const dir = path.join(__dirname, 'assets', 'fonts');
  let ok = false;
  for (const file of ['Inter-Regular.ttf', 'Inter-Bold.ttf']) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) ok = GlobalFonts.registerFromPath(p, 'Inter') || ok;
  }
  if (!ok) {
    // Fall back to whatever the host has (Linux containers may have none)
    try { GlobalFonts.loadSystemFonts(); } catch (_) { /* ignore */ }
  }
  return ok ? 'Inter' : 'sans-serif';
})();

function font(size, weight = '400') {
  return `${weight} ${Math.round(size)}px "${FONT_FAMILY}"`;
}

/** Decimal places for a price: env override, else the instrument's magnitude */
function precisionFor(value) {
  if (cfg.priceDecimals > 0) return cfg.priceDecimals;
  const a = Math.abs(Number(value));
  if (a >= 100) return 3;   // gold: 4,150.740 (matches the TradingView axis)
  if (a >= 1) return 5;
  return 6;
}

function fmtPriceAxis(p) {
  const n = Number(p);
  if (!isFinite(n)) return '-';
  const d = precisionFor(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPrice(p) {
  const n = Number(p);
  if (!isFinite(n)) return '-';
  const d = precisionFor(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Distance/point formatting (box height) — 2dp for anything from 0.01 up */
function fmtAmount(p) {
  const n = Number(p);
  if (!isFinite(n)) return '-';
  if (Math.abs(n) >= 0.01) return n.toFixed(2);
  return n.toFixed(6);
}

/**
 * A price *range* (distance) formatted with the instrument's precision:
 * 5.65 on gold -> '5.650' (matches the axis labels).
 */
function fmtRangeValue(value, digits) {
  const n = Number(value);
  if (!isFinite(n)) return '-';
  const d = Number.isFinite(digits) ? digits : precisionFor(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** TradingView-style round axis step: 1, 2, 2.5 or 5 x 10^n */
function niceStep(span, targetTicks) {
  const raw = span / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/** Rounded rectangle path (kept manual for cross-version canvas support) */
function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
  ctx.closePath();
}

/**
 * Render the snapshot chart.
 *
 * @param {Object} args
 * @param {Array}  args.candles   TradingView candles, oldest -> newest
 * @param {Object} args.box       Result of computeMbox()
 * @param {string} [args.title]   Header title (e.g. 'Gold')
 * @param {string} [args.symbol]  Symbol (e.g. 'OANDA:XAUUSD')
 * @param {number} [args.visibleCandles] Candles to show
 * @param {number} [args.width]   Canvas width  (default CHART_WIDTH, 1080)
 * @param {number} [args.height]  Canvas height (default CHART_HEIGHT, 1920)
 * @param {boolean} [args.projection] Draw dashed extension to candle #extendTo
 * @param {string} [args.timeframeLabel] e.g. '5m'
 * @returns {Buffer} PNG
 */
function renderChart(args) {
  const T = theme();
  const candles = args.candles;
  const box = args.box;
  const timeframe = Number(box && box.timeframe) || 5;
  const stepSec = timeframe * 60;
  const drawProjection = args.projection !== false;

  const W = Math.max(320, Number(args.width) || cfg.width);
  const H = Math.max(480, Number(args.height) || cfg.height);
  const S = W / BASE_WIDTH; // layout scale factor

  const visibleCandles = Math.max(8, Number(args.visibleCandles) || cfg.visibleCandles);

  const headerH = Math.round(128 * S);
  const padLeft = Math.round(18 * S);
  const padRight = Math.round(206 * S); // price axis
  const padBottom = Math.round(66 * S); // time axis
  const padTop = headerH + Math.round(22 * S);
  const plotBottom = H - padBottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);

  // ---------- visible window ----------
  const newestIdx = candles.length - 1;
  const boxLastTime = box.found && box.candlesInBox.length
    ? box.candlesInBox[box.candlesInBox.length - 1].time
    : (box.found ? box.fourthTime : -1);
  const lastBoxIdx = box.found
    ? Math.max(0, candles.findIndex((c) => c.time === boxLastTime))
    : newestIdx;
  // Live run: the box sits at the right edge -> show the newest candles.
  // Backfill run: keep the box in view with a little context to its right.
  const anchorEnd = !box.found || newestIdx - lastBoxIdx <= 5 ? newestIdx : lastBoxIdx + 4;
  const endIdx = Math.min(newestIdx, anchorEnd);
  const startIdx = Math.max(0, endIdx - (visibleCandles - 1));
  const view = candles.slice(startIdx, endIdx + 1);

  // Reserve empty slots on the right so the dashed projection (out to candle
  // #extendTo) stays fully visible, the way TradingView shows the box running
  // forward past the newest candle.
  // The newest candle's own slot is already counted in view.length, so the
  // projection needs one slot less than its distance from that candle.
  const futureSlots = drawProjection && box.found && box.projectionRight > view[view.length - 1].time
    ? Math.max(0, Math.round((box.projectionRight - view[view.length - 1].time) / stepSec) - 1)
    : 0;

  const plotW = W - padLeft - padRight;
  const slot = plotW / (view.length + futureSlots);
  const xOfSlot = (i) => padLeft + i * slot;             // left edge of slot i
  const xOfTime = (t) => xOfSlot((t - view[0].time) / stepSec);

  // ---------- price scale (nice round steps, TradingView style) ----------
  let dataLo = Infinity;
  let dataHi = -Infinity;
  for (const c of view) {
    dataLo = Math.min(dataLo, c.low);
    dataHi = Math.max(dataHi, c.high);
  }
  if (box.found) {
    dataLo = Math.min(dataLo, box.bottom);
    dataHi = Math.max(dataHi, box.top);
  }
  const dataSpan = Math.max(dataHi - dataLo, Math.abs(dataHi) * 1e-6);

  const targetTicks = Math.max(6, Math.round((plotBottom - padTop) / (86 * S)));
  let axisStep = niceStep(dataSpan * 1.06, targetTicks); // small headroom
  let lo = Math.floor(dataLo / axisStep) * axisStep;
  let hi = Math.ceil(dataHi / axisStep) * axisStep;
  if ((hi - lo) / axisStep < 4) { // too few labels -> halve the step
    axisStep /= 2;
    lo = Math.floor(dataLo / axisStep) * axisStep;
    hi = Math.ceil(dataHi / axisStep) * axisStep;
  }
  const yOf = (price) => plotBottom - ((price - lo) / (hi - lo)) * (plotBottom - padTop);

  // ---------- grid + price axis ----------
  const labelFont = Math.round(24 * S);
  ctx.textBaseline = 'middle';
  const ticks = [];
  for (let p = lo; p <= hi + axisStep / 2; p += axisStep) {
    ticks.push(Number(p.toFixed(10)));
  }
  for (const price of ticks) {
    const y = Math.round(yOf(price)) + 0.5;
    if (cfg.showGrid) {
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
    }

    ctx.font = font(labelFont, '500');
    ctx.fillStyle = T.dim;
    ctx.textAlign = 'right';
    ctx.fillText(fmtPriceAxis(price), W - Math.round(14 * S), y);
  }

  // vertical grid on every labelled candle
  const timeFont = Math.round(20 * S);
  const timeLabelEvery = Math.max(2, Math.ceil((78 * S) / slot));
  ctx.textAlign = 'center';
  for (let i = 0; i < view.length; i++) {
    if (i % timeLabelEvery !== 0) continue;
    const x = Math.round(xOfSlot(i)) + 0.5;
    if (cfg.showGrid) {
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
    }

    const label = new Date(view[i].time * 1000).toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    ctx.font = font(timeFont);
    ctx.fillStyle = T.dim;
    ctx.fillText(label, x + slot / 2, plotBottom + Math.round(26 * S));
  }

  // ---------- candles ----------
  // Clipped to the plot area so the box / projection can never bleed over the
  // price axis or the header.
  ctx.save();
  ctx.beginPath();
  ctx.rect(padLeft, padTop, plotW, plotBottom - padTop);
  ctx.clip();

  const bodyW = Math.max(3, Math.min(slot * 0.68, 46 * S));
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const cx = xOfSlot(i) + slot / 2;
    const up = c.close >= c.open;
    const body = up ? T.upBody : T.downBody;
    const border = up ? T.upBorder : T.downBorder;

    // wick
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(1.5, Math.round(bodyW / 9));
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, yOf(c.high));
    ctx.lineTo(Math.round(cx) + 0.5, yOf(c.low));
    ctx.stroke();

    // body
    const yOpen = yOf(c.open);
    const yClose = yOf(c.close);
    const top = Math.min(yOpen, yClose);
    const h = Math.max(2, Math.abs(yClose - yOpen));
    const left = cx - bodyW / 2;
    ctx.fillStyle = body;
    ctx.fillRect(left, top, bodyW, h);
    if (border !== body) {
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(1, Math.round(2 * S));
      ctx.strokeRect(left + 0.5, top + 0.5, bodyW - 1, h - 1);
    }
  }

  // ---------- MBOX box ----------
  if (box.found) {
    const xLeft = xOfTime(box.firstTime);
    const xRight = xOfTime(box.rightEdge);
    const yTop = yOf(box.top);
    const yBottom = yOf(box.bottom);
    const boxStroke = Math.round(3 * S);

    ctx.fillStyle = T.boxFill;
    ctx.fillRect(xLeft, yTop, Math.max(2, xRight - xLeft), Math.max(2, yBottom - yTop));

    ctx.strokeStyle = T.boxBorder;
    ctx.lineWidth = boxStroke;
    ctx.strokeRect(xLeft, yTop, Math.max(2, xRight - xLeft), Math.max(2, yBottom - yTop));

    // Projection: Pine keeps extending the box (set_right) up to candle #extendTo
    if (drawProjection && box.projectionRight > box.rightEdge) {
      const xProj = xOfTime(box.projectionRight);
      ctx.save();
      ctx.setLineDash([Math.round(10 * S), Math.round(8 * S)]);
      ctx.strokeStyle = T.boxBorder;
      ctx.globalAlpha = 0.75;
      ctx.strokeRect(xRight, yTop, Math.max(2, xProj - xRight), Math.max(2, yBottom - yTop));
      ctx.restore();
    }

    // Marker lines for candle #1 open and candle #4 close
    ctx.save();
    ctx.setLineDash([Math.round(5 * S), Math.round(6 * S)]);
    ctx.lineWidth = Math.max(1, Math.round(1.5 * S));
    ctx.strokeStyle = T.boxBorder;
    ctx.globalAlpha = 0.55;
    for (const price of [box.firstOpen, box.fourthClose]) {
      const y = Math.round(yOf(price)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xLeft, y);
      ctx.lineTo(xRight, y);
      ctx.stroke();
    }
    ctx.restore();

    // ---------- MBOX range label — minimal, on the LEFT of the box ----------
    // Shows only the price range (box top - box bottom), e.g. "5.650".
    const digits = precisionFor(box.top);
    const rangeText = fmtRangeValue(box.height, digits);
    const chipFont = Math.round(22 * S);
    ctx.font = font(chipFont, '600');
    const textW = ctx.measureText(rangeText).width;
    const chipH = Math.round(chipFont * 1.9);
    const chipPadX = Math.round(12 * S);
    const chipW = textW + chipPadX * 2;
    const gap = Math.round(12 * S);

    let chipX = xLeft - gap - chipW;                       // outside, left of the box
    if (chipX < padLeft + Math.round(4 * S)) chipX = xLeft + Math.round(6 * S); // no room -> inside left
    let chipY = (yTop + yBottom) / 2 - chipH / 2;          // vertically centred on the box
    chipY = Math.max(padTop + Math.round(4 * S), Math.min(chipY, plotBottom - chipH - Math.round(4 * S)));

    roundRectPath(ctx, chipX, chipY, chipW, chipH, Math.round(6 * S));
    ctx.fillStyle = T.boxBorder;
    ctx.fill();
    ctx.font = font(chipFont, '600');
    ctx.fillStyle = T.tagText;
    ctx.textAlign = 'center';
    ctx.fillText(rangeText, chipX + chipW / 2, chipY + chipH / 2 + Math.round(1 * S));
  }

  ctx.restore(); // end plot-area clip

  // ---------- box price tags on the axis (TradingView style) ----------
  if (box.found) {
    const tagFont = Math.round(24 * S);
    const tagH = Math.round(34 * S);
    const tagX = W - padRight + Math.round(4 * S);
    const tagW = padRight - Math.round(8 * S);
    for (const price of [box.top, box.bottom]) {
      const y = Math.max(padTop, Math.min(plotBottom, yOf(price)));
      roundRectPath(ctx, tagX, y - tagH / 2, tagW, tagH, Math.round(6 * S));
      ctx.fillStyle = T.boxBorder;
      ctx.fill();
      ctx.font = font(tagFont, '600');
      ctx.fillStyle = T.tagText;
      ctx.textAlign = 'right';
      ctx.fillText(fmtPriceAxis(price), W - Math.round(14 * S), y);
    }
  }

  // ---------- header ----------
  ctx.fillStyle = T.panel;
  ctx.fillRect(0, 0, W, headerH);
  ctx.strokeStyle = T.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH + 0.5);
  ctx.lineTo(W, headerH + 0.5);
  ctx.stroke();

  const title = args.title || args.symbol || 'Chart';
  const symbol = args.symbol || '';
  const mar = Math.round(26 * S);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font(38 * S, '600');
  ctx.fillStyle = T.text;
  ctx.fillText(title, mar, Math.round(40 * S));

  ctx.font = font(21 * S);
  ctx.fillStyle = T.dim;
  ctx.fillText(`${symbol}  ·  ${args.timeframeLabel || `${timeframe}m`}  ·  MBOX`, mar, Math.round(78 * S));

  ctx.textAlign = 'right';
  ctx.font = font(30 * S, '600');
  ctx.fillStyle = T.boxLabel;
  ctx.fillText(box.found ? `BOX ${fmtPriceAxis(box.bottom)} – ${fmtPriceAxis(box.top)}` : 'BOX —', W - mar, Math.round(40 * S));

  ctx.font = font(19 * S);
  ctx.fillStyle = T.dim;
  const status = box.found
    ? `${args.stampIST || ''}   |   #1 ${box.startTimeLabel} → #${box.extendTo} ${box.lastBoxCandleLabel} IST${box.confirmed ? '' : ' (unconfirmed)'}`
    : (box.reason || 'no box');
  ctx.fillText(status, W - mar, Math.round(78 * S));

  // ---------- frame ----------
  ctx.strokeStyle = T.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  return canvas.encodeSync('png');
}

module.exports = { renderChart, fmtPrice, fmtPriceAxis, fmtAmount, fmtRangeValue, precisionFor, FONT_FAMILY, THEMES };
