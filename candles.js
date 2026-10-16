require('dotenv').config();
const { Client } = require('@mathieuc/tradingview');

// ============================================================
// TRADINGVIEW CANDLE FETCH (one-shot, no API key, free)
//
// Opens a TradingView chart websocket session, loads the last
// `range` candles of `timeframe`, waits for the history batch to
// settle, then disconnects. This is the same free data feed used
// by the CTC alert project — no TradingView subscription needed.
//
// Candle shape returned by the library:
//   { time, open, max /* high */, min /* low */, close, volume }
// `time` is the epoch (seconds, UTC) at which the candle opened.
// ============================================================

/**
 * @param {Object} opts
 * @param {string} opts.symbol     TradingView symbol, e.g. 'OANDA:XAUUSD'
 * @param {string} [opts.timeframe] Timeframe in minutes, default '5'
 * @param {number} [opts.range]    Candles to load, default 120
 * @param {number} [opts.timeoutMs] Hard timeout, default 45000
 * @param {number} [opts.settleMs]  Quiet period after the last batch, default 1500
 * @param {number} [opts.minCandles] Resolve as soon as this many are loaded and quiet, default 20
 * @returns {Promise<{candles: Array, description: string, symbol: string}>}
 *          candles are ordered OLDEST -> NEWEST
 */
function fetchCandles(opts = {}) {
  const symbol = opts.symbol || 'OANDA:XAUUSD';
  const timeframe = opts.timeframe || '5';
  const range = Number(opts.range) || 120;
  const timeoutMs = Number(opts.timeoutMs) || 45000;
  const settleMs = Number(opts.settleMs) || 1500;
  const minCandles = Number(opts.minCandles) || 20;

  return new Promise((resolve, reject) => {
    const client = new Client();
    const chart = new client.Session.Chart();
    const errors = [];
    let settled = false;
    let settleTimer = null;
    let lastCount = 0;

    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try { client.end(); } catch (_) { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    }

    const hardTimer = setTimeout(() => {
      const loaded = chart.periods ? chart.periods.length : 0;
      done(new Error(
        `TradingView timeout after ${timeoutMs}ms (loaded ${loaded}/${range} candles${
          errors.length ? `; errors: ${errors.join(' | ')}` : ''
        })`
      ));
    }, timeoutMs);

    chart.onError((...args) => {
      errors.push(args.map(String).join(' '));
    });

    chart.onUpdate(() => {
      if (settled || !chart.periods) return;
      const count = chart.periods.length;

      // Already got everything we asked for (TradingView caps history per request)
      if (count >= range) return finish();
      if (count === lastCount) return; // nothing new, keep the existing settle timer

      lastCount = count;
      clearTimeout(settleTimer);
      if (count >= minCandles) {
        // History arrives in batches — give it a quiet period to finish
        settleTimer = setTimeout(finish, settleMs);
      }
    });

    function finish() {
      if (settled) return;
      const candles = (chart.periods || [])
        .map((c) => ({
          time: c.time,
          open: c.open,
          high: c.max,
          low: c.min,
          close: c.close,
          volume: c.volume,
        }))
        .sort((a, b) => a.time - b.time); // oldest -> newest

      if (candles.length < minCandles) {
        if (errors.length) {
          return done(new Error(`TradingView error for ${symbol}: ${errors.join(' | ')}`));
        }
        return done(new Error(
          `Only ${candles.length} candle(s) received for ${symbol} (need at least ${minCandles})`
        ));
      }

      done(null, {
        symbol,
        description: (chart.infos && chart.infos.description) || symbol,
        candles,
      });
    }

    chart.onSymbolLoaded(() => {
      if (chart.infos && chart.infos.description) {
        process.stderr.write(`   📡 Loaded: ${chart.infos.description}\n`);
      }
    });

    chart.setMarket(symbol, { timeframe, range });
  });
}

module.exports = { fetchCandles };
