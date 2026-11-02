/**
 * Cloudflare Worker for the TradingView -> Telegram robot.
 *
 *   Alarm clock (Cron Trigger every minute): starts the GitHub workflow every
 *   N minutes (N is set in the bot). The workflow decides if it is a working day/hour.
 *
 *   Telegram bot:
 *     /chart               -> buttons with your instruments + "All"
 *     /chart usdjpy        -> that instrument right now (OANDA: added automatically)
 *     /settings            -> period (minutes) and range (hours) with buttons
 *     /period 15           -> send every 15 minutes
 *     /range 12            -> show the last 12 hours on the chart
 *
 * Secrets:   TG_TOKEN, GH_TOKEN, ALLOWED_CHAT_ID
 * Variables: SYMBOLS (buttons), DEFAULT_EXCHANGE (default OANDA)
 * Binding:   SETTINGS - a KV namespace (remembers period / range / last run)
 */

const GH_REPO = "akfmn/tv-to-telegram";
const GH_WORKFLOW = "shot.yml";
const DEFAULTS = { period: 10, range: 24 };          // minutes, hours
const PERIODS = [5, 10, 15, 30, 60];
const RANGES = [4, 8, 12, 24, 48];

export default {
  // ---- alarm clock (runs every minute) ----------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  // ---- web + telegram ----------------------------------------------------
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      const webhook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await hookSecret(env),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", {
        commands: [
          { command: "chart", description: "Свежие графики прямо сейчас" },
          { command: "settings", description: "Период отправки и охват графика" },
        ],
      });
      const ok = webhook.ok && commands.ok;
      return text(ok ? "✅ Готово! Напиши боту /chart" : "❌ Ошибка:\n" + JSON.stringify({ webhook, commands }, null, 2));
    }

    if (url.pathname === "/test") {
      const r = await runWorkflow(env, true);
      return text(r.ok ? "✅ GitHub запустил робота, картинки придут через ~1 минуту" : "❌ GitHub ответил " + r.status + "\n" + r.body);
    }

    if (url.pathname === "/status") {
      const s = await getSettings(env);
      return text(JSON.stringify(s, null, 2));
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await hookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handle(update, env));
      return new Response("ok");
    }

    return text("TradingView bot is running");
  },
};

// ---------------------------------------------------------------------------
// settings in KV

async function getSettings(env) {
  let s = {};
  try { s = (await env.SETTINGS.get("settings", "json")) || {}; } catch (e) {}
  return { ...DEFAULTS, ...s };
}

async function saveSettings(env, patch) {
  const s = { ...(await getSettings(env)), ...patch };
  await env.SETTINGS.put("settings", JSON.stringify(s));
  return s;
}

// called every minute; sends when `period` minutes have passed since the last send
async function tick(env) {
  const s = await getSettings(env);
  const now = Date.now();
  const due = !s.lastRun || now - s.lastRun >= s.period * 60000 - 20000; // 20 s tolerance
  if (!due) return;
  await saveSettings(env, { lastRun: now });
  await runWorkflow(env, false);
}

// ---------------------------------------------------------------------------
// telegram helpers

function isAllowed(env, chatId, userId) {
  const allowed = String(env.ALLOWED_CHAT_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  return [String(chatId), String(userId ?? "")].some((id) => allowed.includes(id));
}

function symbolList(env) {
  return String(env.SYMBOLS || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function normalize(env, raw) {
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9:._!]/g, "");
  if (!s) return "";
  if (!s.includes(":")) s = (env.DEFAULT_EXCHANGE || "OANDA").toUpperCase() + ":" + s;
  return s;
}

function shortName(symbol) {
  const t = symbol.split(":").pop();
  if (t.length === 6 && /^[A-Z]+$/.test(t)) return t.slice(0, 3);
  for (const q of ["USDT", "USDC", "BUSD", "USD", "EUR", "BTC"]) {
    if (t.length > q.length + 1 && t.endsWith(q)) return t.slice(0, -q.length);
  }
  return t;
}

function chartKeyboard(env) {
  const syms = symbolList(env);
  const rows = [];
  for (let i = 0; i < syms.length; i += 3) {
    rows.push(syms.slice(i, i + 3).map((s) => ({ text: shortName(s), callback_data: "sym:" + s })));
  }
  rows.push([{ text: "📊 Все графики", callback_data: "sym:*" }]);
  return { inline_keyboard: rows };
}

function fmtHours(h) {
  return h >= 24 && h % 24 === 0 ? `${h / 24} ${h === 24 ? "сутки" : "суток"}` : `${h} ч`;
}

function settingsText(s) {
  return `⚙️ Настройки\n\n⏱ Период отправки: каждые ${s.period} мин\n📏 Охват графика: последние ${fmtHours(s.range)}\n\nМожно и текстом: /period 15 или /range 12`;
}

function settingsKeyboard(s) {
  const mark = (v, cur) => (v === cur ? `• ${v} •` : `${v}`);
  return {
    inline_keyboard: [
      [{ text: "⏱ Период, минут:", callback_data: "noop" }],
      PERIODS.map((p) => ({ text: mark(p, s.period), callback_data: "per:" + p })),
      [{ text: "📏 Охват, часов:", callback_data: "noop" }],
      RANGES.map((r) => ({ text: mark(r, s.range), callback_data: "rng:" + r })),
    ],
  };
}

// ---------------------------------------------------------------------------

async function handle(update, env) {
  // --- buttons ---------------------------------------------------------------
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    const ack = (t) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: t });
    if (!isAllowed(env, chatId, q.from?.id)) return ack();
    const data = String(q.data || "");

    if (data.startsWith("sym:")) {
      const symbols = data === "sym:*" ? "" : data.slice(4);
      const r = await runWorkflow(env, true, symbols);
      const label = symbols ? shortName(symbols) : "все графики";
      await ack(r.ok ? "⏳ Делаю " + label : "Ошибка " + r.status);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: r.ok ? `⏳ Делаю ${label}, пришлю примерно через минуту` : `⚠️ GitHub не запустил робота (${r.status})`,
      });
      return;
    }

    if (data.startsWith("per:") || data.startsWith("rng:")) {
      const v = parseInt(data.slice(4), 10);
      const s = data.startsWith("per:")
        ? await saveSettings(env, { period: v, lastRun: 0 })   // next send right away
        : await saveSettings(env, { range: v });
      await ack("Сохранено");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: settingsText(s), reply_markup: settingsKeyboard(s),
      });
      return;
    }

    return ack();
  }

  // --- text ------------------------------------------------------------------
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (!isAllowed(env, msg.chat.id, msg.from?.id)) return;

  const parts = msg.text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const send = (t, extra = {}) => tg(env, "sendMessage", { chat_id: msg.chat.id, text: t, ...extra });

  if (cmd === "/settings" || cmd === "/start") {
    const s = await getSettings(env);
    return send(settingsText(s), { reply_markup: settingsKeyboard(s) });
  }

  if (cmd === "/period" || cmd === "/range") {
    const v = parseInt(parts[1], 10);
    const isPeriod = cmd === "/period";
    const [min, max] = isPeriod ? [1, 1440] : [1, 720];
    if (!v || v < min || v > max) {
      return send(isPeriod ? "Напиши число минут, например: /period 15" : "Напиши число часов, например: /range 12");
    }
    const s = isPeriod ? await saveSettings(env, { period: v, lastRun: 0 }) : await saveSettings(env, { range: v });
    return send(settingsText(s), { reply_markup: settingsKeyboard(s) });
  }

  if (cmd !== "/chart") return;

  const wanted = parts.slice(1).map((p) => normalize(env, p)).filter(Boolean);
  if (wanted.length === 0) {
    return send("Какой график прислать?\nИли напиши, например: /chart usdjpy", { reply_markup: chartKeyboard(env) });
  }
  const r = await runWorkflow(env, true, wanted.join(","));
  const names = wanted.map(shortName).join(", ");
  return send(r.ok
    ? `⏳ Делаю ${names}, пришлю примерно через минуту`
    : `⚠️ GitHub не запустил робота (${r.status}). Проверь GH_TOKEN в Cloudflare.\n${r.body.slice(0, 300)}`);
}

// Press "Run workflow" on GitHub, passing the remembered range.
async function runWorkflow(env, force, symbols = "") {
  const s = await getSettings(env);
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tv-to-telegram-worker",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { force: force ? "true" : "false", symbols, view_hours: String(s.range) },
      }),
    }
  );
  return { ok: r.status === 204, status: r.status, body: r.ok ? "" : await r.text() };
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function text(s) {
  return new Response(s, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function hookSecret(env) {
  const data = new TextEncoder().encode("tv-hook:" + env.TG_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
