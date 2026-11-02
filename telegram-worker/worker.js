/**
 * Cloudflare Worker for the TradingView -> Telegram robot. Two jobs:
 *   1. Alarm clock: every 10 minutes (Cron Trigger) it starts the GitHub workflow.
 *      The workflow itself decides whether it is a working day/hour.
 *   2. Telegram bot:
 *        /chart            -> buttons with your instruments + "All"
 *        /chart usdjpy     -> that instrument right now (OANDA: added automatically)
 *        /chart eurusd gbpusd  -> several at once
 *
 * Worker secrets (Settings -> Variables and Secrets, type "Secret"):
 *   TG_TOKEN         - same bot token as in GitHub
 *   GH_TOKEN         - GitHub fine-grained token: only repo tv-to-telegram,
 *                      permission "Actions: Read and write"
 *   ALLOWED_CHAT_ID  - your Telegram id (same as TG_CHAT_ID); several = comma-separated
 * Worker variables (plain text):
 *   SYMBOLS          - buttons, e.g. OANDA:EURUSD,OANDA:GBPUSD
 *   DEFAULT_EXCHANGE - prefix for symbols typed without one, default OANDA
 *
 * Cron Trigger (Settings -> Triggers -> Cron Triggers):  every 10 minutes
 * After deploy, open once in the browser:  https://<your-worker>.workers.dev/setup
 */

const GH_REPO = "akfmn/tv-to-telegram";
const GH_WORKFLOW = "shot.yml";

export default {
  // ---- alarm clock -------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWorkflow(env, false));
  },

  // ---- web + telegram ----------------------------------------------------
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One-time: connect the bot to this worker and add /chart to the bot menu
    if (url.pathname === "/setup") {
      const webhook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await hookSecret(env),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", {
        commands: [{ command: "chart", description: "Свежие графики прямо сейчас" }],
      });
      const ok = webhook.ok && commands.ok;
      return text(ok ? "✅ Готово! Напиши боту /chart" : "❌ Ошибка:\n" + JSON.stringify({ webhook, commands }, null, 2));
    }

    // Manual check that the GitHub token works: opens the robot once
    if (url.pathname === "/test") {
      const r = await runWorkflow(env, true);
      return text(r.ok ? "✅ GitHub запустил робота, картинки придут через ~1 минуту" : "❌ GitHub ответил " + r.status + "\n" + r.body);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      // Only Telegram knows this secret, so nobody else can trigger the bot
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await hookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handle(update, env)); // answer Telegram fast, work in background
      return new Response("ok");
    }

    return text("TradingView bot is running");
  },
};

// ---------------------------------------------------------------------------

function isAllowed(env, chatId, userId) {
  const allowed = String(env.ALLOWED_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [String(chatId), String(userId ?? "")].some((id) => allowed.includes(id));
}

function symbolList(env) {
  return String(env.SYMBOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// "usdjpy" -> "OANDA:USDJPY", "binance:btcusdt" -> "BINANCE:BTCUSDT"
function normalize(env, raw) {
  let s = raw.trim().toUpperCase().replace(/[^A-Z0-9:._!]/g, "");
  if (!s) return "";
  if (!s.includes(":")) s = (env.DEFAULT_EXCHANGE || "OANDA").toUpperCase() + ":" + s;
  return s;
}

// OANDA:EURUSD -> EUR (same rule as the watermark on the chart)
function shortName(symbol) {
  const t = symbol.split(":").pop();
  if (t.length === 6 && /^[A-Z]+$/.test(t)) return t.slice(0, 3);
  for (const q of ["USDT", "USDC", "BUSD", "USD", "EUR", "BTC"]) {
    if (t.length > q.length + 1 && t.endsWith(q)) return t.slice(0, -q.length);
  }
  return t;
}

function keyboard(env) {
  const syms = symbolList(env);
  const rows = [];
  for (let i = 0; i < syms.length; i += 3) {
    rows.push(syms.slice(i, i + 3).map((s) => ({ text: shortName(s), callback_data: "sym:" + s })));
  }
  rows.push([{ text: "📊 Все графики", callback_data: "sym:*" }]);
  return { inline_keyboard: rows };
}

async function handle(update, env) {
  // --- button pressed -------------------------------------------------------
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    if (!isAllowed(env, chatId, q.from?.id)) {
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
      return;
    }
    const data = String(q.data || "");
    const symbols = data === "sym:*" ? "" : data.replace(/^sym:/, "");
    const r = await runWorkflow(env, true, symbols);
    const label = symbols ? shortName(symbols) : "все графики";
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? "⏳ Делаю " + label : "Ошибка " + r.status });
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: r.ok ? `⏳ Делаю ${label}, пришлю примерно через минуту` : `⚠️ GitHub не запустил робота (${r.status})`,
    });
    return;
  }

  // --- text message -----------------------------------------------------------
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (!isAllowed(env, msg.chat.id, msg.from?.id)) return; // strangers get no answer

  const parts = msg.text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase(); // "/chart@MyBot" -> "/chart"
  if (cmd !== "/chart" && cmd !== "/start") return;

  const wanted = parts.slice(1).map((p) => normalize(env, p)).filter(Boolean);

  if (wanted.length === 0) {
    // No symbol given -> show buttons
    const hint = "Какой график прислать?\nИли напиши, например: /chart usdjpy";
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: hint, reply_markup: keyboard(env) });
    return;
  }

  const symbols = wanted.join(",");
  const r = await runWorkflow(env, true, symbols);
  const names = wanted.map(shortName).join(", ");
  const reply = r.ok
    ? `⏳ Делаю ${names}, пришлю примерно через минуту`
    : `⚠️ GitHub не запустил робота (${r.status}). Проверь GH_TOKEN в Cloudflare.\n${r.body.slice(0, 300)}`;
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: reply });
}

// Press "Run workflow" on GitHub. force=true -> send now, ignoring working hours.
// symbols: "" = the list from CHART_URL, otherwise only these (comma-separated).
async function runWorkflow(env, force, symbols = "") {
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
      body: JSON.stringify({ ref: "main", inputs: { force: force ? "true" : "false", symbols } }),
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

// Webhook secret derived from the bot token (no extra setting needed)
async function hookSecret(env) {
  const data = new TextEncoder().encode("tv-hook:" + env.TG_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
