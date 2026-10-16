#!/usr/bin/env node
// ============================================================
// CLI: build a MBOX snapshot now (useful for testing / backfill)
//
//   node scripts/snapshot.js                        send today's snapshot to Telegram
//   node scripts/snapshot.js --no-send              render only (no Telegram)
//   node scripts/snapshot.js --no-send --save       render + save PNG to output/
//   node scripts/snapshot.js --date=2026-10-15 --now-ist=17:50 --no-send --save
//   node scripts/snapshot.js --symbol=OANDA:EURUSD --no-send
//
// --now-ist=HH:MM pretends "now" is that IST time on --date, which reproduces
// exactly what the 5:50 PM job sees (box at candle #4, projection to #extendTo).
// ============================================================

const cfg = require('../config');
const { runSnapshot } = require('../snapshot');
const { fmtPriceAxis, fmtRangeValue, precisionFor } = require('../chart');
const { istWallClockToEpoch, istDateKey, parseHHMM } = require('../mbox');

const args = process.argv.slice(2);
const get = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};
const val = (name) => {
  const v = get(name);
  return v === true || v === null ? null : v;
};

(async () => {
  const dateIST = val('date');
  let nowSec;
  const nowISTArg = val('now-ist');
  if (nowISTArg) {
    const hhmm = parseHHMM(nowISTArg, null);
    if (!hhmm) throw new Error(`--now-ist must look like 17:50 (got "${nowISTArg}")`);
    nowSec = istWallClockToEpoch(dateIST || istDateKey(), hhmm.hour, hhmm.minute);
  }

  const res = await runSnapshot({
    dateIST,
    nowSec,
    symbol: val('symbol'),
    visibleCandles: val('candles') ? Number(val('candles')) : undefined,
    range: val('range') ? Number(val('range')) : undefined,
    send: args.includes('--no-send') ? false : val('send') !== 'false',
    save: args.includes('--save') || cfg.savePng,
  });

  const box = res.box || {};
  console.log(`\n── ${res.description || res.symbol} (${res.symbol}) ──`);
  console.log(`   candles loaded : ${res.candleCount}  (${res.fetchMs}ms)`);
  console.log(`   trading day    : ${res.dateIST}`);
  if (!box.found) {
    console.log(`   ❌ no box: ${res.reason}`);
    process.exit(1);
  }
  console.log(`   #1 open  ${box.startTimeLabel} : ${fmtPriceAxis(box.firstOpen)}`);
  console.log(`   #4 close ${box.fourthTimeLabel} : ${fmtPriceAxis(box.fourthClose)}`);
  console.log(`   box top/bottom : ${fmtPriceAxis(box.top)} / ${fmtPriceAxis(box.bottom)}  (${box.direction}, range=${fmtRangeValue(box.height, precisionFor(box.top))})`);
  console.log(`   right edge     : ${new Date(box.rightEdge * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })}`);
  console.log(`   extends to     : #${box.extendTo} (${box.lastBoxCandleLabel} IST)   confirmed: ${box.confirmed}`);
  if (res.savedTo) console.log(`   png            : ${res.savedTo}  (${res.pngBytes} bytes)`);
  console.log(`   telegram       : ${res.telegram ? JSON.stringify(res.telegram) : 'not sent'}`);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
