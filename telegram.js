// ============================================================
// TELEGRAM — photo + text helpers (Node 18+ global fetch/FormData)
// ============================================================

const cfg = require('./config');

/**
 * Send a PNG to a Telegram chat/channel.
 * For channels the bot must be an admin; chat id is `@channelname` or `-100...`.
 *
 * @param {Buffer} png
 * @param {string} caption  HTML caption (parse_mode = HTML)
 * @param {Object} [opts]   { token, chatId, filename }
 */
async function sendTelegramPhoto(png, caption, opts = {}) {
  const token = opts.token || cfg.telegram.token;
  const chatId = opts.chatId || cfg.telegram.chatId;
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured' };

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption || '');
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([png], { type: 'image/png' }), opts.filename || 'mbox.png');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { ok: false, status: res.status, reason: body.description || `HTTP ${res.status}` };
  }
  return { ok: true, messageId: body.result && body.result.message_id };
}

/**
 * Send a plain text/HTML message.
 */
async function sendTelegramMessage(text, opts = {}) {
  const token = opts.token || cfg.telegram.token;
  const chatId = opts.chatId || cfg.telegram.chatId;
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured' };

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { ok: false, status: res.status, reason: body.description || `HTTP ${res.status}` };
  }
  return { ok: true, messageId: body.result && body.result.message_id };
}

/** Escape dynamic text going into an HTML-parsed Telegram message */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendTelegramPhoto, sendTelegramMessage, escapeHtml };
