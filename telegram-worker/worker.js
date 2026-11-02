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
 *     /hours 8-18          -> automatic sending only between 08:00 and 18:00 (Jerusalem)
 *     /on  /off            -> turn automatic sending on / off (/chart always works)
 *
 * Secrets:   TG_TOKEN, GH_TOKEN, ALLOWED_CHAT_ID
 * Variables: SYMBOLS (main instruments, sent automatically by default),
 *            EXTRA_SYMBOLS (optional instruments, off by default - toggle in /settings),
 *            DEFAULT_EXCHANGE (default OANDA)
 * Binding:   SETTINGS - a KV namespace (remembers period / range / last run)
 */

const GH_REPO = "akfmn/tv-to-telegram";
const GH_WORKFLOW = "shot.yml";
const DEFAULTS = { period: 10, range: 24, from: 9, to: 17, enabled: true }; // minutes, hours, work hours
const PERIODS = [5, 10, 15, 30, 60];
const RANGES = [4, 8, 12, 24, 48];
const STARTS = [6, 7, 8, 9, 10, 11, 12];
const ENDS = [14, 15, 16, 17, 18, 20, 23];

// Permanent buttons under the message box (no slash commands needed)
const BTN = { chart: "📊 График", settings: "⚙️ Настройки", on: "▶️ Старт", off: "⏸ Стоп" };
const MENU = {
  keyboard: [[{ text: BTN.chart }, { text: BTN.settings }], [{ text: BTN.on }, { text: BTN.off }]],
  resize_keyboard: true,
  is_persistent: true,
};

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
          { command: "menu", description: "Показать кнопки" },
          { command: "settings", description: "Старт/стоп, период, охват, часы" },
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
  if (!s.enabled) return;                       // paused with the Stop button
  const now = Date.now();
  const due = !s.lastRun || now - s.lastRun >= s.period * 60000 - 20000; // 20 s tolerance
  if (!due) return;
  const symbols = activeList(env, s).join(",");
  if (!symbols) return;                         // nothing switched on
  await saveSettings(env, { lastRun: now });
  await runWorkflow(env, false, symbols);
}

// ---------------------------------------------------------------------------
// telegram helpers

function isAllowed(env, chatId, userId) {
  const allowed = String(env.ALLOWED_CHAT_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  return [String(chatId), String(userId ?? "")].some((id) => allowed.includes(id));
}

const splitList = (v) => String(v || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

function symbolList(env, s = {}) {
  const all = [...splitList(env.SYMBOLS), ...splitList(env.EXTRA_SYMBOLS), ...(s.extra || [])];
  return [...new Set(all)];
}

// instruments that go out automatically (main ones by default)
function activeList(env, s) {
  return Array.isArray(s.active) ? s.active : splitList(env.SYMBOLS);
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

function chartKeyboard(env, s) {
  const syms = symbolList(env, s);
  const act = activeList(env, s);
  const rows = [];
  for (let i = 0; i < syms.length; i += 3) {
    rows.push(syms.slice(i, i + 3).map((x) => ({ text: (act.includes(x) ? "" : "· ") + shortName(x), callback_data: "sym:" + x })));
  }
  rows.push([{ text: "📊 Все включённые", callback_data: "sym:*" }]);
  return { inline_keyboard: rows };
}

function fmtHours(h) {
  return h >= 24 && h % 24 === 0 ? `${h / 24} ${h === 24 ? "сутки" : "суток"}` : `${h} ч`;
}

const hh = (h) => String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.round((h % 1) * 60)).padStart(2, "0");
const workHours = (s) => `${hh(s.from)}-${hh(s.to)}`;

function settingsText(env, s) {
  const state = s.enabled ? "▶️ ВКЛЮЧЕНА" : "⏸ ОСТАНОВЛЕНА";
  const act = activeList(env, s).map(shortName).join(", ") || "ничего не выбрано";
  return `⚙️ Настройки\n\n🤖 Автоотправка: ${state}\n📈 Инструменты: ${act}\n⏱ Период отправки: каждые ${s.period} мин\n📏 Охват графика: последние ${fmtHours(s.range)}\n🕘 Часы автоотправки: с ${hh(s.from)} до ${hh(s.to)}, пн–пт\n\nТекстом: /period 15, /range 12, /hours 8-18, /add usdjpy, /del usdjpy`;
}

function settingsKeyboard(env, s) {
  const mark = (v, cur) => (v === cur ? `• ${v} •` : `${v}`);
  const syms = symbolList(env, s);
  const act = activeList(env, s);
  const symRows = [];
  for (let i = 0; i < syms.length; i += 4) {
    symRows.push(syms.slice(i, i + 4).map((x) => ({ text: (act.includes(x) ? "✅ " : "⬜ ") + shortName(x), callback_data: "tog:" + x })));
  }
  return {
    inline_keyboard: [
      [{ text: "📈 Присылать автоматически:", callback_data: "noop" }],
      ...symRows,
      [s.enabled
        ? { text: "⏸ Стоп — не присылать автоматически", callback_data: "en:0" }
        : { text: "▶️ Старт — присылать автоматически", callback_data: "en:1" }],
      [{ text: "⏱ Период, минут:", callback_data: "noop" }],
      PERIODS.map((p) => ({ text: mark(p, s.period), callback_data: "per:" + p })),
      [{ text: "📏 Охват, часов:", callback_data: "noop" }],
      RANGES.map((r) => ({ text: mark(r, s.range), callback_data: "rng:" + r })),
      [{ text: "🕘 Начало автоотправки:", callback_data: "noop" }],
      STARTS.map((h) => ({ text: mark(h, s.from), callback_data: "frm:" + h })),
      [{ text: "🕔 Конец автоотправки:", callback_data: "noop" }],
      ENDS.map((h) => ({ text: mark(h, s.to), callback_data: "to:" + h })),
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

    if (data.startsWith("tog:")) {
      const cur = await getSettings(env);
      const sym = data.slice(4);
      const act = activeList(env, cur);
      const next = act.includes(sym) ? act.filter((x) => x !== sym) : [...act, sym];
      const s = await saveSettings(env, { active: next });
      await ack(act.includes(sym) ? shortName(sym) + " выключен" : shortName(sym) + " включён");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: settingsText(env, s), reply_markup: settingsKeyboard(env, s),
      });
      return;
    }

    if (data.startsWith("sym:")) {
      const cur = await getSettings(env);
      const symbols = data === "sym:*" ? activeList(env, cur).join(",") : data.slice(4);
      if (!symbols) return ack("Нет включённых инструментов");
      const r = await runWorkflow(env, true, symbols);
      const label = data === "sym:*" ? "все включённые" : shortName(symbols);
      await ack(r.ok ? "⏳ Делаю " + label : "Ошибка " + r.status);
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: r.ok ? `⏳ Делаю ${label}, пришлю примерно через минуту` : `⚠️ GitHub не запустил робота (${r.status})`,
      });
      return;
    }

    if (/^(per|rng|frm|to|en):/.test(data)) {
      const [key, raw] = data.split(":");
      const v = parseInt(raw, 10);
      const cur = await getSettings(env);
      let patch = {};
      if (key === "en") patch = { enabled: v === 1, lastRun: 0 };  // on start: send right away
      if (key === "per") patch = { period: v, lastRun: 0 };      // next send right away
      if (key === "rng") patch = { range: v };
      if (key === "frm") patch = { from: v, to: Math.max(cur.to, v + 1) };
      if (key === "to") patch = { to: v, from: Math.min(cur.from, v - 1) };
      const s = await saveSettings(env, patch);
      await ack("Сохранено");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: settingsText(env, s), reply_markup: settingsKeyboard(env, s),
      });
      return;
    }

    return ack();
  }

  // --- text ------------------------------------------------------------------
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (!isAllowed(env, msg.chat.id, msg.from?.id)) return;

  const raw = msg.text.trim();
  const alias = raw === BTN.chart ? "/chart" : raw === BTN.settings ? "/settings"
              : raw === BTN.on ? "/on" : raw === BTN.off ? "/off" : null;
  const parts = (alias || raw).split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const send = (t, extra = {}) => tg(env, "sendMessage", { chat_id: msg.chat.id, text: t, ...extra });

  if (cmd === "/start" || cmd === "/menu") {
    // show the permanent button panel, then the settings
    await send("Кнопки внизу: 📊 График — прислать сейчас, ⚙️ Настройки, ▶️ Старт / ⏸ Стоп — автоотправка.", { reply_markup: MENU });
    const s = await getSettings(env);
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/settings") {
    const s = await getSettings(env);
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/add" || cmd === "/del") {
    const sym = normalize(env, parts[1] || "");
    if (!sym) return send(cmd === "/add" ? "Напиши инструмент, например: /add usdjpy" : "Напиши инструмент, например: /del usdjpy");
    const cur = await getSettings(env);
    const extra = (cur.extra || []).filter((x) => x !== sym);
    const act = activeList(env, cur).filter((x) => x !== sym);
    const s = cmd === "/add"
      ? await saveSettings(env, { extra: [...extra, sym], active: [...act, sym] })
      : await saveSettings(env, { extra, active: act });
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/on" || cmd === "/off") {
    const s = await saveSettings(env, { enabled: cmd === "/on", lastRun: 0 });
    return send(cmd === "/on"
      ? `▶️ Автоотправка включена: каждые ${s.period} мин, с ${hh(s.from)} до ${hh(s.to)}, пн–пт. Первый график уже делаю.`
      : "⏸ Автоотправка остановлена. 📊 График по кнопке работает как обычно.");
  }

  if (cmd === "/hours") {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?$/.exec(parts.slice(1).join(" "));
    if (!m) return send("Напиши часы, например: /hours 8-18 или /hours 8:30-17:30");
    const from = +m[1] + (m[2] ? +m[2] / 60 : 0), to = +m[3] + (m[4] ? +m[4] / 60 : 0);
    if (from >= to || to > 24) return send("Начало должно быть раньше конца, например: /hours 8-18");
    const s = await saveSettings(env, { from, to });
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/period" || cmd === "/range") {
    const v = parseInt(parts[1], 10);
    const isPeriod = cmd === "/period";
    const [min, max] = isPeriod ? [1, 1440] : [1, 720];
    if (!v || v < min || v > max) {
      return send(isPeriod ? "Напиши число минут, например: /period 15" : "Напиши число часов, например: /range 12");
    }
    const s = isPeriod ? await saveSettings(env, { period: v, lastRun: 0 }) : await saveSettings(env, { range: v });
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd !== "/chart") return;

  const wanted = parts.slice(1).map((p) => normalize(env, p)).filter(Boolean);
  if (wanted.length === 0) {
    const s = await getSettings(env);
    return send("Какой график прислать?\nИли напиши, например: /chart usdjpy", { reply_markup: chartKeyboard(env, s) });
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
        inputs: { force: force ? "true" : "false", symbols, view_hours: String(s.range), work_hours: workHours(s) },
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
