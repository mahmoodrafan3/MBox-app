// ============================================================
// SNAPSHOT PIPELINE
//   fetch TradingView candles -> compute MBOX -> render PNG -> Telegram
//
// If the run starts before candle #4 has closed (before 17:50 IST), the
// pipeline waits for that close and re-fetches, so the box levels are always
// the real Pine levels instead of a half-formed candle.
// ============================================================

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { fetchCandles } = require('./candles');
const { computeMbox, istDateKey, istWallClockToEpoch, parseHHMM } = require('./mbox');
const { renderChart, fmtPriceAxis, fmtRangeValue, precisionFor } = require('./chart');
const { sendTelegramPhoto, sendTelegramMessage, escapeHtml } = require('./telegram');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'Thu 15 Oct 2026 · 17:50 IST' */
function istStamp(epochSec) {
  const d = new Date(epochSec * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
  const time = new Date(epochSec * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${d} · ${time} IST`;
}

function buildCaption({ description, symbol, box, timeframe, sentAtSec }) {
  const lines = [];
  lines.push(`🟪 <b>MBOX — ${escapeHtml(description || symbol)}</b>`);
  lines.push(`<code>${escapeHtml(symbol)}  ·  ${timeframe}m  ·  ${escapeHtml(istStamp(sentAtSec))}</code>`);
  lines.push('');
  lines.push(`<b>Box Top:</b> ${fmtPriceAxis(box.top)}`);
  lines.push(`<b>Box Bottom:</b> ${fmtPriceAxis(box.bottom)}`);
  lines.push(`<b>Height:</b> ${fmtRangeValue(box.height, precisionFor(box.top))} pts  ·  ${box.direction} box`);
  lines.push('');
  lines.push(`#1 open  ${box.startTimeLabel} → ${fmtPriceAxis(box.firstOpen)}`);
  lines.push(`#4 close ${box.fourthTimeLabel} → ${fmtPriceAxis(box.fourthClose)}`);
  lines.push(`Extends to #${box.extendTo} (${box.lastBoxCandleLabel} IST)`);
  if (!box.confirmed) lines.push('⚠️ candle #4 not confirmed yet — provisional levels');
  return lines.join('\n');
}

function savePng(png, symbol, dateIST) {
  fs.mkdirSync(cfg.outputDir, { recursive: true });
  const file = path.join(cfg.outputDir, `mbox-${symbol.replace(/[^A-Za-z0-9]/g, '_')}-${dateIST}.png`);
  fs.writeFileSync(file, png);
  return file;
}

/**
 * Run the whole snapshot.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dateIST]  IST date to build the box for (default today)
 * @param {boolean} [opts.send]    Send to Telegram (default true)
 * @param {boolean} [opts.save]    Save the PNG under output/ (default cfg.savePng)
 * @param {number}  [opts.nowSec]  Simulate "now" (seconds) — disables the confirm-wait
 * @returns {Promise<Object>} result summary
 */
async function runSnapshot(opts = {}) {
  const startedAt = Date.now();
  const simulated = opts.nowSec !== undefined && opts.nowSec !== null;
  let nowSec = simulated ? opts.nowSec : Math.floor(Date.now() / 1000);
  const dateIST = opts.dateIST || istDateKey(nowSec);
  const send = opts.send !== false;
  const symbol = opts.symbol || cfg.symbol;
  const timeframe = String(opts.timeframe || cfg.timeframe);
  const step = Number(timeframe) * 60 || 300;

  // Load enough history to reach the box start (17:30 IST), plus right-side context.
  // Always measured against the real clock: a simulated view must still fetch
  // enough candles to reach the box.
  const boxStart = parseHHMM(cfg.boxStartIST, { hour: 17, minute: 30 });
  const startSec = istWallClockToEpoch(dateIST, boxStart.hour, boxStart.minute);
  const needed = Math.ceil((Math.floor(Date.now() / 1000) - startSec) / step) + cfg.visibleCandles + 10;
  const range = opts.range || Math.min(Math.max(cfg.historyRange, needed), 5000);

  const result = {
    ok: false,
    sent: false,
    symbol,
    dateIST,
    simulated,
    waitedSec: 0,
  };

  // ---- 1+2. candles + box, waiting for candle #4 to close if we are early ----
  let candles; let description; let box;
  const maxWaitSec = simulated ? 0 : (opts.maxWaitSec !== undefined ? opts.maxWaitSec : cfg.waitForConfirmSec);

  for (;;) {
    const fetched = await fetchCandles({ symbol, timeframe, range });
    candles = fetched.candles;
    description = fetched.description;
    box = computeMbox(candles, {
      symbol,
      dateIST,
      startIST: cfg.boxStartIST,
      extendTo: cfg.extendTo,
      timeframe: Number(timeframe),
      nowSec,
    });

    if (!box.found) break;

    // Snapshot moment = candle #4 close (17:50 IST). Read the feed a few
    // seconds after it so the final close tick is included, and re-check.
    const confirmedAt = box.fourthTime + step;
    const settledAt = confirmedAt + cfg.settleSec;
    if (box.confirmed && nowSec >= settledAt) break;
    if (maxWaitSec <= 0) break;

    const wait = settledAt - nowSec;
    if (wait <= 0 || result.waitedSec + wait > maxWaitSec) break;

    console.log(`   ⏳ candle #4 closes at ${box.fourthTimeLabel} IST (+${cfg.settleSec}s settle) — waiting ${wait}s for final levels...`);
    await sleep(wait * 1000);
    result.waitedSec += wait;
    nowSec = Math.floor(Date.now() / 1000); // real clock again
  }

  result.candleCount = candles.length;
  result.description = description;
  result.box = box;
  result.fetchMs = Date.now() - startedAt;

  if (!box.found) {
    result.reason = box.reason;
    if (send && cfg.notifyOnFailure) {
      const notice = `⚠️ <b>MBOX snapshot skipped</b>\n<code>${escapeHtml(symbol)}</code>\n${escapeHtml(box.reason)}`;
      result.notice = await sendTelegramMessage(notice).catch((e) => ({ ok: false, reason: e.message }));
    }
    return result;
  }

  // ---- 3. render PNG (only candles that exist as of the snapshot moment) ----
  const renderCandles = candles.filter((c) => c.time <= nowSec);
  const png = renderChart({
    candles: renderCandles.length >= 10 ? renderCandles : candles,
    box,
    title: description || symbol,
    symbol,
    visibleCandles: opts.visibleCandles || cfg.visibleCandles,
    width: opts.width || cfg.width,
    height: opts.height || cfg.height,
    projection: cfg.drawProjection,
    timeframeLabel: `${timeframe}m`,
    stampIST: istStamp(nowSec),
  });
  result.png = png;
  result.pngBytes = png.length;
  result.sentAtSec = nowSec;

  if (opts.save || cfg.savePng) result.savedTo = savePng(png, symbol, dateIST);

  // ---- 4. Telegram ----
  const caption = buildCaption({ description, symbol, box, timeframe, sentAtSec: nowSec });
  result.caption = caption;

  if (send && cfg.telegram.token && cfg.telegram.chatId) {
    result.telegram = await sendTelegramPhoto(png, caption, { filename: `mbox-${dateIST}.png` });
    result.sent = !!result.telegram.ok;
    if (!result.sent) result.reason = result.telegram.reason;
  } else if (send) {
    // Rendering worked, there is just nowhere to post yet.
    result.telegram = { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured' };
    result.reason = result.telegram.reason;
  }

  result.ok = !send || result.sent || !!result.telegram.skipped;
  result.totalMs = Date.now() - startedAt;
  return result;
}

module.exports = { runSnapshot, buildCaption, istStamp, savePng };
