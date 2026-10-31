/**
 * Telegram command /chart -> runs the GitHub "TradingView screenshot" workflow.
 * Deploy as a Cloudflare Worker (free). Fresh charts arrive in ~1 minute.
 *
 * Worker secrets (Settings -> Variables and Secrets, type "Secret"):
 *   TG_TOKEN         - same bot token as in GitHub
 *   GH_TOKEN         - GitHub fine-grained token: only repo tv-to-telegram,
 *                      permission "Actions: Read and write"
 *   ALLOWED_CHAT_ID  - your Telegram id (same as TG_CHAT_ID); several = comma-separated
 *
 * After deploy, open once in the browser:  https://<your-worker>.workers.dev/setup
 */

const GH_REPO = "akfmn/tv-to-telegram";
const GH_WORKFLOW = "shot.yml";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One-time: connect the bot to this worker and add /chart to the bot menu
    if (url.pathname === "/setup") {
      const webhook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: await hookSecret(env),
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", {
        commands: [{ command: "chart", description: "Свежие графики прямо сейчас" }],
      });
      const ok = webhook.ok && commands.ok;
      return new Response(
        ok ? "✅ Готово! Напиши боту /chart" : "❌ Ошибка:\n" + JSON.stringify({ webhook, commands }, null, 2),
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
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

    return new Response("TradingView bot is running", { status: 200 });
  },
};

async function handle(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const allowed = String(env.ALLOWED_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  const who = [String(msg.chat.id), String(msg.from?.id ?? "")];
  if (!who.some((id) => allowed.includes(id))) return; // strangers get no answer

  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase(); // "/chart@MyBot" -> "/chart"
  if (cmd !== "/chart" && cmd !== "/start") return;

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
      body: JSON.stringify({ ref: "main" }),
    }
  );

  const text = r.status === 204
    ? "⏳ Делаю свежие скриншоты, пришлю примерно через минуту"
    : `⚠️ GitHub не запустил робота (${r.status}). Проверь GH_TOKEN в Cloudflare.\n${(await r.text()).slice(0, 300)}`;
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text });
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Webhook secret derived from the bot token (no extra setting needed)
async function hookSecret(env) {
  const data = new TextEncoder().encode("tv-hook:" + env.TG_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
