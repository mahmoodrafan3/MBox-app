// ============================================================
// MBOX ALERT — daily TradingView chart snapshot to Telegram
//
//  * pulls candles from the free TradingView websocket feed
//  * rebuilds the MBOX box (17:30 -> 18:15 IST, per the Pine script)
//  * renders a candlestick PNG in Node (no browser, no Python)
//  * posts it to a Telegram chat/channel at 5:50 PM IST (Mon-Fri) — candle #4 close
//
// Runs as a Render free Web Service: an HTTP endpoint wakes it up and
// GitHub Actions (or cron-job.org) hits /trigger once a day.
// ============================================================

require('dotenv').config();

const http = require('http');
const cfg = require('./config');
const { runSnapshot } = require('./snapshot');
const { sendTelegramMessage } = require('./telegram');
const { nowIST, parseHHMM } = require('./mbox');

const PORT = process.env.PORT || 3000;

// ============================================================
// ANSI COLOURS (same style as the CTC alert project)
// ============================================================
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const c = (t, col) => `${col}${t}${C.reset}`;
const dim = (t) => c(t, C.gray);

// ============================================================
// STATE
// ============================================================
const state = {
  startedAt: new Date().toISOString(),
  lastAttemptAt: 0,
  lastResult: null,
  sentDates: {}, // { 'YYYY-MM-DD': { status, at, source, error } }
  inFlight: false,
};

/** True once the day's snapshot is handled — delivered, or rendered with no channel set */
function alreadySent(dateKey) {
  const s = state.sentDates[dateKey] && state.sentDates[dateKey].status;
  return s === 'sent' || s === 'rendered';
}

/** Keep only the most recent 30 days of bookkeeping */
function pruneSentDates() {
  const keys = Object.keys(state.sentDates).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete state.sentDates[k];
}

/** Minutes-of-day in IST for the local clock */
function istMinutesOfDay() {
  const p = nowIST();
  return p.hour * 60 + p.minute;
}

const hhmmToMinutes = (str, fallback) => {
  const p = parseHHMM(str, null);
  if (!p) return fallback;
  return p.hour * 60 + p.minute;
};

// ============================================================
// TRIGGER (shared by the scheduler, /trigger and the CLI)
// ============================================================
async function triggerSnapshot({ dateIST, force = false, send = true, source = 'manual' } = {}) {
  const ist = nowIST();
  const key = dateIST || ist.dateKey;

  if (!force && alreadySent(key)) {
    return { ok: true, skipped: true, reason: `already sent for ${key}`, sentFor: key };
  }
  if (state.inFlight) {
    return { ok: false, skipped: true, reason: 'a snapshot is already running' };
  }
  // Small anti-hammer guard between attempts of a failed/triggered run
  const sinceLast = Date.now() - state.lastAttemptAt;
  if (!force && state.lastResult && sinceLast < 20000) {
    return { ok: false, skipped: true, reason: `waiting ${Math.ceil((20000 - sinceLast) / 1000)}s before retrying` };
  }

  state.inFlight = true;
  state.lastAttemptAt = Date.now();
  state.sentDates[key] = { status: 'sending', at: new Date().toISOString(), source };

  console.log(`\n${c('▶', C.magenta)} ${C.bold}SNAPSHOT${C.reset} ${dim(`(${source})`)} ${key} ${ist.hour}:${String(ist.minute).padStart(2, '0')} IST`);

  try {
    const res = await runSnapshot({ dateIST: key, send });
    if (res.savedTo) console.log(dim(`   saved ${res.savedTo} (${res.pngBytes} bytes)`));

    if (res.ok) {
      const box = res.box || {};
      console.log(`   ${c('✓', C.green)} box ${box.direction}  top ${box.top}  bottom ${box.bottom}  (h=${box.height && box.height.toFixed(2)})`);
      console.log(`   ${res.sent ? c('📨 sent to Telegram', C.green) : c(`not delivered: ${res.reason || 'send disabled'}`, C.yellow)}  ${dim(`${res.totalMs}ms`)}`);
      state.sentDates[key] = { status: res.sent ? 'sent' : 'rendered', at: new Date().toISOString(), source };
    } else {
      console.log(`   ${c('✗', C.red)} ${res.reason || 'failed'}`);
      state.sentDates[key] = { status: 'failed', at: new Date().toISOString(), source, error: res.reason || 'failed' };
    }

    state.lastResult = res;
    pruneSentDates();
    return res;
  } catch (err) {
    console.error(`   ${c('✗', C.red)} ${err.message}`);
    state.sentDates[key] = { status: 'failed', at: new Date().toISOString(), source, error: err.message };
    state.lastResult = { ok: false, reason: err.message, dateIST: key };

    if (send && cfg.notifyOnFailure) {
      await sendTelegramMessage(
        `⚠️ <b>MBOX snapshot failed</b>\n<code>${cfg.symbol}</code>\n${err.message}`
      ).catch(() => {});
    }
    return { ok: false, reason: err.message, dateIST: key };
  } finally {
    state.inFlight = false;
  }
}

// ============================================================
// DAILY SCHEDULER (IST) — fires while the service is awake
// ============================================================
const targetMin = hhmmToMinutes(cfg.sendIST, 17 * 60 + 51);

function schedulerTick() {
  if (!cfg.dailyEnabled) return;
  const ist = nowIST();
  if (cfg.weekdaysOnly && (ist.weekday === 0 || ist.weekday === 6)) return;
  if (alreadySent(ist.dateKey)) return;

  const nowMin = ist.hour * 60 + ist.minute;
  if (nowMin < targetMin || nowMin > targetMin + cfg.sendGraceMin) return;

  const source = nowMin === targetMin ? 'scheduler' : 'scheduler (late wake)';
  triggerSnapshot({ dateIST: ist.dateKey, source });
}

// ============================================================
// HTTP SERVER (Render Web Service health check + trigger)
// ============================================================
const OK = Buffer.from('OK');

// The PNG buffer belongs in /preview.png, never in a JSON body
const jsonSafe = (obj) => JSON.stringify(obj, (k, v) => (k === 'png' ? undefined : v), 2);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  // Render / cron-job.org health check — 2 bytes, cheap on cold start
  if (route === '/health' || route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': OK.length });
    res.end(OK);
    return;
  }

  if (route === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      sendIST: cfg.sendIST,
      extendTo: cfg.extendTo,
      telegramConfigured: !!(cfg.telegram.token && cfg.telegram.chatId),
      startedAt: state.startedAt,
      nowIST: `${nowIST().dateKey} ${nowIST().hour}:${String(nowIST().minute).padStart(2, '0')}`,
      sentDates: state.sentDates,
      inFlight: state.inFlight,
      lastResult: state.lastResult,
    }, (k, v) => (k === 'png' ? undefined : v), 2));
    return;
  }

  if (route === '/trigger') {
    // Optional shared-secret protection: ?key=... or x-trigger-key header
    if (cfg.triggerKey) {
      const provided = url.searchParams.get('key') || req.headers['x-trigger-key'];
      if (provided !== cfg.triggerKey) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
    }

    const result = await triggerSnapshot({
      dateIST: url.searchParams.get('date') || undefined,
      force: url.searchParams.get('force') === '1',
      send: url.searchParams.get('send') !== 'false',
      source: url.searchParams.get('source') || 'http',
    });
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(jsonSafe(result));
    return;
  }

  // Quick visual check in a browser: /preview.png (does not touch Telegram unless send=1)
  if (route === '/preview.png') {
    const result = await triggerSnapshot({
      dateIST: url.searchParams.get('date') || undefined,
      force: true,
      send: url.searchParams.get('send') === '1',
      source: 'preview',
    });
    if (!result.png) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(result.reason || 'render failed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(result.png);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (err) => console.error(`   ${c('🌐 health server error:', C.red)} ${err.message}`));

server.listen(PORT, () => {
  console.log('');
  console.log(c('╔══════════════════════════════════════════════════════════════╗', C.magenta));
  console.log(c('║', C.magenta) + c('   MBOX  ·  TradingView chart photo → Telegram', C.bold) + c('                ║', C.magenta));
  console.log(c('╚══════════════════════════════════════════════════════════════╝', C.magenta));
  console.log(`   ${dim('Symbol     ')} ${C.bold}${cfg.symbol}${C.reset} ${dim(`${cfg.timeframe}m`)}`);
  console.log(`   ${dim('Box        ')} ${cfg.boxStartIST} IST candle #1 → #${cfg.extendTo} ${dim('(candle #4 close defines top/bottom)')}`);
  console.log(`   ${dim('Daily send ')} ${C.bold}${cfg.sendIST} IST${C.reset} ${dim(cfg.weekdaysOnly ? 'Mon-Fri' : 'every day')} ${dim(`(+${cfg.sendGraceMin} min grace on late wake)`)}`);
  console.log(`   ${dim('Telegram   ')} ${cfg.telegram.token && cfg.telegram.chatId ? c('✅ configured', C.green) : c('❌ set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID', C.yellow)}`);
  console.log(`   ${dim('Trigger key')} ${cfg.triggerKey ? c('✅ protected', C.green) : c('⚠️  open (set TRIGGER_KEY)', C.yellow)}`);
  console.log(`   ${dim('HTTP       ')} port ${PORT} ${dim('— /health  /status  /trigger  /preview.png')}`);
  console.log('');

  setInterval(schedulerTick, cfg.schedulerTickMs);
  schedulerTick();
  console.log(dim(`   ⏰ scheduler running (checks every ${cfg.schedulerTickMs / 1000}s, IST)`));
});

// ============================================================
// INTERNAL KEEPALIVE — keeps Render awake only around the send window
// (free tier spins down after ~15 min idle; GitHub Actions wakes it first)
// ============================================================
if (cfg.renderUrl) {
  const fromMin = hhmmToMinutes(cfg.keepaliveFromIST, 17 * 60 + 20);
  const toMin = hhmmToMinutes(cfg.keepaliveToIST, 18 * 60);
  const inWindow = () => {
    const m = istMinutesOfDay();
    return m >= fromMin && m <= toMin;
  };

  setTimeout(() => {
    setInterval(async () => {
      if (!inWindow()) return;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 15000);
        const r = await fetch(cfg.renderUrl, { signal: controller.signal });
        clearTimeout(t);
        if (!r.ok) console.error(`   ⚠️ keepalive ${r.status}`);
      } catch (err) {
        if (err.name !== 'AbortError') console.error(`   ⚠️ keepalive: ${err.message}`);
      }
    }, cfg.keepaliveIntervalMs);
  }, 30000);

  console.log(dim(`   🔄 keepalive ${cfg.keepaliveFromIST}-${cfg.keepaliveToIST} IST every ${cfg.keepaliveIntervalMs / 60000} min`));
}

// ============================================================
// SHUTDOWN
// ============================================================
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

module.exports = { triggerSnapshot, state };
