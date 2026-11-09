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
 * Bindings:  SETTINGS - a KV namespace (remembers period / range / last run)
 *            AI       - Workers AI (free tier) - understands "биткоин", "эпл", "нефть"...
 */

const GH_REPO = "akfmn/tv-to-telegram";
const GH_WORKFLOW = "shot.yml";
const DEFAULTS = { period: 10, range: 24, from: 9, to: 17, enabled: true }; // minutes, hours, work hours
const PERIODS = [5, 10, 15, 30, 60];
const RANGES = [4, 8, 12, 24, 48];
const STARTS = [6, 7, 8, 9, 10, 11, 12];
const ENDS = [14, 15, 16, 17, 18, 20, 23];

const HELP = [
  "📖 КАК ПОЛЬЗОВАТЬСЯ БОТОМ",
  "",
  "Бот присылает скриншоты твоих графиков TradingView (со всеми твоими индикаторами). Есть два режима:",
  "• АВТООТПРАВКА — сам присылает по расписанию.",
  "• ПО ЗАПРОСУ — нажал кнопку, через ~40 секунд пришла картинка.",
  "",
  "━━━ КНОПКИ ВНИЗУ ЧАТА ━━━",
  "📊 График — прислать сейчас. Покажет список инструментов: нажми нужный или «Все включённые». Работает всегда, даже когда автоотправка остановлена и в выходные.",
  "⚙️ Настройки — всё, что ниже, включая Старт/Стоп.",
  "Панель кнопок сворачивается после нажатия. Открыть снова: значок клавиатуры ⌨️ справа от поля ввода, или команда /menu.",
  "",
  "━━━ НАСТРОЙКИ ━━━",
  "⏸ Стоп / ▶️ Старт — выключить или включить автоотправку. При Стоп ничего не удаляется, настройки сохраняются; при Старт первый график придёт сразу.",
  "📈 Присылать автоматически — галочки у инструментов. ✅ приходит по расписанию, ⬜ нет. Нажал — переключил. Выключенный инструмент всё равно можно запросить через 📊 График.",
  "⏱ Период, минут — как часто присылать: 5, 10, 15, 30 или 60. После смены период считается заново, первый график придёт сразу.",
  "📏 Охват, часов — сколько последних часов видно на картинке: 4, 8, 12, 24 или 48. Робот сам подгоняет масштаб, чтобы влезли ровно эти часы и все свечи по высоте.",
  "🕘 Начало / 🕔 Конец автоотправки — в какие часы присылать (время Иерусалима). За пределами этих часов, а также в субботу и воскресенье, автоотправки нет.",
  "",
  "━━━ ПРОСТО НАПИШИ НАЗВАНИЕ ━━━",
  "Бот понимает обычные слова: «биткоин», «эфир», «эпл», «амазон», «золото», «нефть», «насдак», «евро»… и даже несколько сразу: «эпл и тесла». Редкие названия он распознаёт через ИИ. Через ~40 секунд придёт график по нашему шаблону.",
  "Можно указать таймфрейм и индикаторы только для этого графика: «apple дневной с ma 150», «биткоин часовой rsi 14 macd», «золото 15 минут ema 200». Слово «только» — скрыть твои индикаторы: «эпл дневной только ma 150». Таймфреймы: минутка, 5/15/30 минут, часовой, 4 часа, дневной, недельный. Индикаторы: ma/sma, ema, rsi, macd, bollinger, vwap, объём, atr, стохастик, ишимоку, supertrend, psar. Твой сохранённый график при этом не меняется.",
  "",
  "━━━ ШАБЛОНЫ (кнопки внизу) ━━━",
  "Кнопка = готовый таймфрейм и индикаторы. Нажал шаблон → бот спросил инструмент → написал «Coca-Cola» → пришёл график. «Чистый» = без твоих индикаторов на этом снимке. Управление: /presets; добавить словами: «добавь шаблон Дневной RSI: дневной rsi 14 чистый»; удалить: «удали шаблон Дневной RSI».",
  "",
  "━━━ ДРУГИЕ ЛЮДИ ━━━",
  "Боту можно писать и в личку, не только в группу. Чужой человек пишет боту /start — тебе приходит «Иван хочет пользоваться ботом» с кнопками Разрешить/Отклонить. Разрешённые получают графики себе в личку и не видят группу; настройки менять не могут. Список и удаление — /users или кнопка 👥 в настройках.",
  "",
  "━━━ ТЕКСТОВЫЕ КОМАНДЫ ━━━",
  "Нужны, когда нужного значения нет на кнопках:",
  "/chart usdjpy — график любого инструмента, даже если его нет в списке. Можно несколько: /chart eurusd gbpusd. Биржа подставится сама (OANDA); другую пиши явно: /chart binance:btcusdt",
  "/period 7 — период в минутах (любое число 1–1440)",
  "/range 36 — охват в часах (1–720)",
  "/hours 8:30-17:30 — часы автоотправки, можно с минутами",
  "/add usdjpy — добавить инструмент в список (сразу включается). Или просто словами: «добавь в рассылку биткоин», «убери из рассылки золото»",
  "/del usdjpy — убрать инструмент из списка",
  "/on и /off — то же, что кнопки Старт и Стоп",
  "/menu — показать кнопки внизу, если они пропали",
  "/help — эта справка",
  "",
  "━━━ ЧТО ВАЖНО ЗНАТЬ ━━━",
  "• Картинка показывает твой основной график TradingView: индикаторы, линии и цвета берутся из него. Робот ничего в графике не меняет и не сохраняет.",
  "• Если долго не приходят картинки в рабочее время — проверь, что автоотправка включена (⚙️ Настройки) и что есть хотя бы одна галочка у инструментов.",
  "• Если бот написал «TradingView login expired» — нужно обновить два секрета TV_SESSIONID и TV_SESSIONID_SIGN в GitHub (см. инструкцию у Клода).",
  "• Бот отвечает только тебе. Чужие сообщения игнорирует.",
].join("\n");

// Permanent buttons under the message box (no slash commands needed)
const BTN = { chart: "📊 График", settings: "⚙️ Настройки", on: "▶️ Старт", off: "⏸ Стоп" };
// Two buttons; the panel folds away after a tap and comes back with the
// keyboard icon next to the message box (one_time_keyboard).
const MENU = {
  keyboard: [[{ text: BTN.chart }, { text: BTN.settings }]],
  resize_keyboard: true,
  one_time_keyboard: true,
  is_persistent: false,
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
          { command: "help", description: "Что делает каждая кнопка и команда" },
          { command: "users", description: "Кто может пользоваться ботом (владелец)" },
          { command: "presets", description: "Шаблоны-кнопки: таймфрейм + индикаторы (владелец)" },
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
      // short line in Observability -> easy to see what came in and what the bot did
      const m = update.message || update.edited_message;
      console.log("tg update", JSON.stringify({
        kind: update.callback_query ? "callback:" + update.callback_query.data : m ? (m.text ? "text" : m.voice ? "voice" : Object.keys(m).slice(-1)[0]) : Object.keys(update).join(","),
        chat: m?.chat?.id ?? update.callback_query?.message?.chat?.id, from: m?.from?.id ?? update.callback_query?.from?.id, text: m?.text,
      }));
      ctx.waitUntil(handle(update, env).catch((e) => console.error("handle failed", e.stack || e.message)));
      return new Response("ok");
    }

    // Diagnostics: is the webhook healthy, is AI attached
    // Diagnostics: what would the bot make of this text?  /ai?q=кока кола
    if (url.pathname === "/ai") {
      const res = await resolveSymbols(env, url.searchParams.get("q") || "");
      return text(JSON.stringify(res, null, 2));
    }

    if (url.pathname === "/hook") {
      const info = await tg(env, "getWebhookInfo", {});
      return text(JSON.stringify({ ai: !!env.AI, webhook: info.result }, null, 2));
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

// Who may do what:
//   owner  - OWNER_ID (or any id in ALLOWED_CHAT_ID): everything, incl. settings
//   group  - messages inside the ALLOWED_CHAT_ID group: everything (as before)
//   user   - approved by the owner (/start -> owner taps "Разрешить"): charts only, to their own chat
//   none   - nobody; private chat gets an invitation to /start
const idList = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
async function getUsers(env) {
  try { return (await env.SETTINGS.get("users", "json")) || {}; } catch (e) { return {}; }
}
async function saveUsers(env, users) { await env.SETTINGS.put("users", JSON.stringify(users)); }
function ownerIds(env) {
  const ids = idList(env.OWNER_ID);
  return ids.length ? ids : idList(env.ALLOWED_CHAT_ID).filter((x) => !x.startsWith("-"));
}
async function roleOf(env, chatId, userId) {
  const cid = String(chatId), uid = String(userId ?? "");
  if (ownerIds(env).includes(uid)) return "owner";
  if (idList(env.ALLOWED_CHAT_ID).includes(cid)) return "group";
  const users = await getUsers(env);
  if (users[uid]?.ok) return "user";
  return "none";
}
const canConfigure = (role) => role === "owner" || role === "group";
const userName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") + (u?.username ? ` (@${u.username})` : "");
async function notifyOwners(env, text, extra = {}) {
  for (const id of ownerIds(env)) await tg(env, "sendMessage", { chat_id: id, text, ...extra });
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
      [{ text: "❓ Помощь — что делает каждая кнопка", callback_data: "help" }, { text: "👥 Пользователи", callback_data: "users" }],
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
// free text -> TradingView symbols: fast dictionary first, Workers AI for the rest

const DICT = {
  // crypto
  "биткоин": "BINANCE:BTCUSDT", "биток": "BINANCE:BTCUSDT", "битка": "BINANCE:BTCUSDT", "битк": "BINANCE:BTCUSDT",
  "btc": "BINANCE:BTCUSDT", "bitcoin": "BINANCE:BTCUSDT", "втс": "BINANCE:BTCUSDT", "бтс": "BINANCE:BTCUSDT", "биткойн": "BINANCE:BTCUSDT", "бтц": "BINANCE:BTCUSDT",
  "эфир": "BINANCE:ETHUSDT", "эфириум": "BINANCE:ETHUSDT", "этериум": "BINANCE:ETHUSDT", "eth": "BINANCE:ETHUSDT", "ethereum": "BINANCE:ETHUSDT",
  "солана": "BINANCE:SOLUSDT", "sol": "BINANCE:SOLUSDT", "solana": "BINANCE:SOLUSDT",
  "рипл": "BINANCE:XRPUSDT", "xrp": "BINANCE:XRPUSDT", "доги": "BINANCE:DOGEUSDT", "doge": "BINANCE:DOGEUSDT", "догикоин": "BINANCE:DOGEUSDT",
  // metals / energy
  "золото": "OANDA:XAUUSD", "gold": "OANDA:XAUUSD", "xau": "OANDA:XAUUSD", "голд": "OANDA:XAUUSD",
  "серебро": "OANDA:XAGUSD", "silver": "OANDA:XAGUSD", "xag": "OANDA:XAGUSD",
  "нефть": "TVC:USOIL", "oil": "TVC:USOIL", "wti": "TVC:USOIL", "брент": "TVC:UKOIL", "brent": "TVC:UKOIL", "газ": "NYMEX:NG1!",
  // forex
  "евро": "OANDA:EURUSD", "eur": "OANDA:EURUSD", "eurusd": "OANDA:EURUSD", "евродоллар": "OANDA:EURUSD",
  "фунт": "OANDA:GBPUSD", "gbp": "OANDA:GBPUSD", "gbpusd": "OANDA:GBPUSD", "кабель": "OANDA:GBPUSD",
  "йена": "OANDA:USDJPY", "иена": "OANDA:USDJPY", "jpy": "OANDA:USDJPY", "usdjpy": "OANDA:USDJPY",
  "франк": "OANDA:USDCHF", "chf": "OANDA:USDCHF", "аусси": "OANDA:AUDUSD", "aud": "OANDA:AUDUSD", "киви": "OANDA:NZDUSD", "nzd": "OANDA:NZDUSD",
  "канадец": "OANDA:USDCAD", "cad": "OANDA:USDCAD", "доллар": "TVC:DXY", "dxy": "TVC:DXY", "индекс доллара": "TVC:DXY",
  // indices
  "насдак": "OANDA:NAS100USD", "nasdaq": "OANDA:NAS100USD", "us100": "OANDA:NAS100USD", "nas100": "OANDA:NAS100USD", "ндх": "OANDA:NAS100USD",
  "сп500": "OANDA:SPX500USD", "sp500": "OANDA:SPX500USD", "us500": "OANDA:SPX500USD", "спх": "OANDA:SPX500USD", "spx": "OANDA:SPX500USD", "s&p": "OANDA:SPX500USD",
  "доу": "OANDA:US30USD", "dow": "OANDA:US30USD", "us30": "OANDA:US30USD", "дакс": "OANDA:DE30EUR", "dax": "OANDA:DE30EUR", "никкей": "OANDA:JP225USD",
  // stocks
  "эпл": "NASDAQ:AAPL", "эппл": "NASDAQ:AAPL", "apple": "NASDAQ:AAPL", "aapl": "NASDAQ:AAPL",
  "амазон": "NASDAQ:AMZN", "amazon": "NASDAQ:AMZN", "amzn": "NASDAQ:AMZN",
  "тесла": "NASDAQ:TSLA", "tesla": "NASDAQ:TSLA", "tsla": "NASDAQ:TSLA",
  "майкрософт": "NASDAQ:MSFT", "microsoft": "NASDAQ:MSFT", "msft": "NASDAQ:MSFT",
  "гугл": "NASDAQ:GOOGL", "google": "NASDAQ:GOOGL", "googl": "NASDAQ:GOOGL", "альфабет": "NASDAQ:GOOGL",
  "нвидиа": "NASDAQ:NVDA", "nvidia": "NASDAQ:NVDA", "nvda": "NASDAQ:NVDA", "невидия": "NASDAQ:NVDA",
  "мета": "NASDAQ:META", "meta": "NASDAQ:META", "фейсбук": "NASDAQ:META", "нетфликс": "NASDAQ:NFLX", "netflix": "NASDAQ:NFLX",
  "амд": "NASDAQ:AMD", "amd": "NASDAQ:AMD", "интел": "NASDAQ:INTC", "intel": "NASDAQ:INTC", "кока кола": "NYSE:KO", "кокакола": "NYSE:KO",
  "макдональдс": "NYSE:MCD", "найк": "NYSE:NKE", "nike": "NYSE:NKE", "боинг": "NYSE:BA", "boeing": "NYSE:BA", "дисней": "NYSE:DIS",
  "палантир": "NASDAQ:PLTR", "pltr": "NASDAQ:PLTR", "койнбейс": "NASDAQ:COIN", "coinbase": "NASDAQ:COIN", "микростратеджи": "NASDAQ:MSTR", "mstr": "NASDAQ:MSTR",
};
const FILLER = new Set(["и", "а", "или", "график", "графики", "покажи", "пришли", "дай", "скинь", "мне", "пожалуйста", "плиз", "please",
  "chart", "show", "the", "please", "сейчас", "now", "курс", "цена", "по", "на", "за", "сегодня", "с", "со", "для", "of", "for", "with"]);

const AI_SYSTEM = `You convert a user's request (Russian or English, may contain slang or typos) into TradingView symbols.
Reply ONLY with a JSON array of strings, nothing else. Empty array [] if no financial instrument is mentioned.
Rules: crypto -> BINANCE:<COIN>USDT (bitcoin -> BINANCE:BTCUSDT). Forex -> OANDA:EURUSD style. Gold OANDA:XAUUSD, silver OANDA:XAGUSD,
oil TVC:USOIL, brent TVC:UKOIL, dollar index TVC:DXY. Indices: Nasdaq100 OANDA:NAS100USD, S&P500 OANDA:SPX500USD, Dow OANDA:US30USD, DAX OANDA:DE30EUR.
US stocks -> NASDAQ:TICKER or NYSE:TICKER (Apple NASDAQ:AAPL, Coca-Cola NYSE:KO). Other countries -> that exchange (e.g. LSE:, XETR:, MOEX:, TSE:).
Several instruments -> several entries. Max 5.`;

// Telegram voice note (ogg/opus) -> text via Workers AI Whisper
async function transcribe(env, file) {
  if (!env.AI) return "";
  try {
    const f = await tg(env, "getFile", { file_id: file.file_id });
    if (!f.ok) return "";
    const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${f.result.file_path}`);
    const buf = await r.arrayBuffer();
    const out = await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(buf)] });
    return String(out.text || "").trim();
  } catch (e) {
    console.error("transcribe failed", e.message);
    return "";
  }
}

// "пришли график Apple дневной с индикатором moving 150"
//   -> { interval: "1D", studies: ["sma:150"], only: false, rest: "apple" }
// Timeframe and indicators are cut out of the text; what is left goes to the symbol resolver.
const TF_WORDS = [
  [/(^|\s)(минутк[аиу]|1\s*мин(ут[аы]?)?|1\s*m|m1)(?=\s|$)/, "1"],
  [/(^|\s)(\d+)\s*(мин(ут[аы]?)?|m|min)(?=\s|$)/, (m) => m[2]],
  [/(^|\s)(часов(ой|ик|ым)?|hourly|1\s*h|h1|1\s*час)(?=\s|$)/, "60"],
  [/(^|\s)(\d+)\s*(ч|час[аов]*|h)(?=\s|$)/, (m) => String(+m[2] * 60)],
  [/(^|\s)(дневн[а-яa-z]*|дейли|daily|1\s*d|d1|день|сутки|суточн[а-яa-z]*)(?=\s|$)/, "1D"],
  [/(^|\s)(недельн[а-яa-z]*|неделя|weekly|1\s*w|w1)(?=\s|$)/, "1W"],
  [/(^|\s)(месячн[а-яa-z]*|месяц|monthly|1\s*mo)(?=\s|$)/, "1M"],
];
const STUDY_WORDS = [
  [/(^|\s)(ema|экспоненциальн[а-яa-z]*(\s+скользящ[а-яa-z]*)?|эма)\s*(\d+)?(?=\s|$)/, "ema"],
  [/(^|\s)(sma|ma|moving(\s+average)?|мувинг|скользящ[а-яa-z]*(\s+средн[а-яa-z]*)?|средн[а-яa-z]*|машк[аи]|ма)\s*(\d+)?(?=\s|$)/, "sma"],
  [/(^|\s)(rsi|рси| рсай)\s*(\d+)?(?=\s|$)/, "rsi"],
  [/(^|\s)(macd|макд|макди)(?=\s|$)/, "macd"],
  [/(^|\s)(bollinger(\s+bands)?|bb|боллинджер[а-яa-z]*|боллиндж[а-яa-z]*|полос[а-яa-z]*\s+боллинджера)\s*(\d+)?(?=\s|$)/, "bb"],
  [/(^|\s)(vwap|вивап)(?=\s|$)/, "vwap"],
  [/(^|\s)(volume|объ[её]м[а-яa-z]*)(?=\s|$)/, "volume"],
  [/(^|\s)(atr|атр)\s*(\d+)?(?=\s|$)/, "atr"],
  [/(^|\s)(stoch[а-яa-z]*|стохастик[а-яa-z]*)(?=\s|$)/, "stoch"],
  [/(^|\s)(ichimoku|ишимоку|ичимоку)(?=\s|$)/, "ichimoku"],
  [/(^|\s)(supertrend|супертренд)(?=\s|$)/, "supertrend"],
  [/(^|\s)(psar|parabolic(\s+sar)?|параболик[а-яa-z]*)(?=\s|$)/, "psar"],
  [/(^|\s)(cci)\s*(\d+)?(?=\s|$)/, "cci"], [/(^|\s)(adx)(?=\s|$)/, "adx"], [/(^|\s)(obv)(?=\s|$)/, "obv"],
];

function parseRequest(raw) {
  let t = " " + raw.toLowerCase().replace(/ё/g, "е").replace(/[,.!?]/g, " ").replace(/\s+/g, " ") + " ";
  const out = { interval: "", studies: [], only: false };
  if (/\s(только|без моих|без остальных|без других|чист(ый|ая|ое)|без индикаторов|clean)\s/.test(t)) {
    out.only = true;
    t = t.replace(/\s(только с|только|без моих|без остальных|без других|чист(ый|ая|ое)|без индикаторов|clean|график)\s/g, " ");
  }
  t = t.replace(/\s(таймфрейм[а-яa-z]*|тф|timeframe|tf|период[а-яa-z]*|интервал[а-яa-z]*|индикатор[а-яa-z]*|с индикатор[а-яa-z]*|indicator[а-яa-z]*|добавь|и)\s/g, " ");
  for (const [re, val] of TF_WORDS) {
    const m = t.match(re);
    if (m) { out.interval = typeof val === "function" ? val(m) : val; t = t.replace(re, " "); break; }
  }
  for (let guard = 0; guard < 6; guard++) {          // several indicators in one phrase
    let hit = false;
    for (const [re, code] of STUDY_WORDS) {
      const m = t.match(re);
      if (!m) continue;
      const n = (m[m.length - 1] || "").match(/^\d+$/) ? m[m.length - 1] : "";
      out.studies.push(code + (n ? ":" + n : ""));
      t = t.replace(re, " ");
      hit = true;
      break;
    }
    if (!hit) break;
  }
  out.rest = t.replace(/\s+/g, " ").trim();
  return out;
}

const studyLabel = (c) => { const [code, n] = c.split(":"); return code.toUpperCase() + (n ? " " + n : ""); };
const prettyInterval = (iv) => /^\d+$/.test(iv) ? (+iv % 60 === 0 && +iv >= 60 ? +iv / 60 + "h" : iv + "m") : iv;

// "⏳ Делаю AAPL (NASDAQ:AAPL) · 1D · SMA 150, пришлю примерно через минуту"
function describe(symbols, q) {
  const parts = [symbols.map((x) => `${shortName(x)} (${x})`).join(", ")];
  if (q?.interval) parts.push(prettyInterval(q.interval));
  if (q?.studies?.length) parts.push(q.studies.map(studyLabel).join(", ") + (q.only ? " (только они)" : ""));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// presets: a button = timeframe + indicators chosen by the owner; the person only
// types the instrument.  spec is a plain phrase parsed by parseRequest().
const DEFAULT_PRESETS = [
  { name: "📅 Дневной MA 150", spec: "дневной ma 150 чистый" },
  { name: "🕐 Часовой чистый", spec: "часовой чистый" },
  { name: "📆 Недельный чистый", spec: "недельный чистый" },
  { name: "⚡ 5 минут", spec: "" },
];
async function getPresets(env) {
  try { const p = await env.SETTINGS.get("presets", "json"); if (Array.isArray(p)) return p; } catch (e) {}
  return DEFAULT_PRESETS;
}
async function savePresets(env, list) { await env.SETTINGS.put("presets", JSON.stringify(list)); }
const findPreset = (list, text) => list.find((p) => p.name.toLowerCase() === text.toLowerCase().trim());
function presetKeyboard(presets, role) {
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) rows.push(presets.slice(i, i + 2).map((p) => ({ text: p.name })));
  rows.push(canConfigure(role) ? [{ text: BTN.chart }, { text: BTN.settings }] : [{ text: BTN.chart }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function presetText(p) {
  const q = parseRequest(p.spec || "");
  const bits = [q.interval ? prettyInterval(q.interval) : "5m", ...(q.studies.length ? [q.studies.map(studyLabel).join(", ")] : []), q.only ? "без индикаторов владельца" : "индикаторы владельца"];
  return bits.join(" · ");
}
async function sendPresets(env, chatId) {
  const list = await getPresets(env);
  const text = ["🧩 Шаблоны (кнопки внизу у всех пользователей)", "",
    ...list.map((p, i) => `${i + 1}. ${p.name} — ${presetText(p)}`), "",
    "Добавить: добавь шаблон Название: дневной rsi 14 чистый", "Удалить: кнопкой ниже или «удали шаблон Название»"].join("\n");
  const kb = list.map((p, i) => [{ text: `🗑 ${p.name}`.slice(0, 60), callback_data: "pdel:" + i }]);
  kb.push([{ text: "↩️ Вернуть стандартные", callback_data: "pdef" }]);
  await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: kb } });
}
// "добавь шаблон Дневной RSI: дневной rsi 14 чистый" -> { add, name, spec } ; "удали шаблон Дневной RSI" -> { add:false, name }
function parsePresetEdit(raw) {
  const m = raw.match(/^(добавь|добавить|создай|удали|удалить|убери)\s+шаблон\s+(.+)$/i);
  if (!m) return null;
  const add = /^(добав|созда)/i.test(m[1]);
  const [name, ...rest] = m[2].split(/[:—-]\s*/);
  return { add, name: name.trim(), spec: rest.join(" ").trim() };
}

// owner: list of approved users with "remove" buttons
async function sendUsers(env, chatId) {
  const users = await getUsers(env);
  const ok = Object.entries(users).filter(([, u]) => u.ok);
  const pending = Object.entries(users).filter(([, u]) => !u.ok);
  const lines = ["👥 Пользователи бота", "", ...(ok.length ? ok.map(([id, u]) => `✅ ${u.name} (id ${id})`) : ["пока никого, кроме тебя"])];
  if (pending.length) lines.push("", "⏳ Ждут ответа:", ...pending.map(([id, u]) => `• ${u.name} (id ${id})`));
  const kb = [
    ...ok.map(([id, u]) => [{ text: `🗑 убрать ${u.name}`.slice(0, 60), callback_data: "rm:" + id }]),
    ...pending.map(([id, u]) => [{ text: `✅ ${u.name}`.slice(0, 30), callback_data: "acc:" + id }, { text: "🚫", callback_data: "rej:" + id }]),
  ];
  await tg(env, "sendMessage", { chat_id: chatId, text: lines.join("\n"), reply_markup: kb.length ? { inline_keyboard: kb } : undefined });
}

// "добавь в рассылку биткоин и эфир" -> { add: true, what: "биткоин и эфир" }
function parseListEdit(raw) {
  const t = raw.toLowerCase().replace(/ё/g, "е").trim();
  const m = t.match(/^(добавь|добавить|добав|подключи|включи|убери|убрать|удали|удалить|отключи|выключи)\s+(.*)$/);
  if (!m) return null;
  const add = /^(добав|подключ|включ)/.test(m[1]);
  // (\b does not work with Cyrillic, so word edges are spaces / string ends)
  const what = (" " + m[2] + " ")
    .replace(/\s(в|из|с|со)\s+(авто)?(рассылку|рассылки|рассылке|список|списка|бот|бота|боту|автоотправку|автоотправки)(?=\s)/g, " ")
    .replace(/\s(пожалуйста|плиз|еще|тоже|также|тикер|инструмент|график|графики)(?=\s)/g, " ")
    .replace(/\s+/g, " ").trim();
  return what ? { add, what } : null;
}

// add or remove instruments in the list; returns [text, extra] for send()
async function editList(env, add, symbols) {
  const cur = await getSettings(env);
  let extra = cur.extra || [];
  let act = activeList(env, cur);
  for (const sym of symbols) {
    extra = extra.filter((x) => x !== sym);
    act = act.filter((x) => x !== sym);
    if (add) { extra.push(sym); act.push(sym); }
  }
  const s = await saveSettings(env, { extra, active: act });
  const names = symbols.map((x) => `${shortName(x)} (${x})`).join(", ");
  const head = add ? `✅ Добавил в рассылку: ${names}` : `🗑 Убрал из рассылки: ${names}`;
  return [head + "\n\n" + settingsText(env, s), { reply_markup: settingsKeyboard(env, s) }];
}

// Cloudflare retires models now and then; the bot tries these in order.
const AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-3b-instruct",
];

async function resolveSymbols(env, text) {
  const t = text.toLowerCase().replace(/ё/g, "е");
  // 1) whole phrase in the dictionary?
  if (DICT[t.trim()]) return { symbols: [DICT[t.trim()]], via: "dict" };
  // 2) word by word
  const words = t.split(/[\s,;]+/).filter((w) => w && !FILLER.has(w));
  const hits = words.map((w) => DICT[w] || (/^[a-z]{2,10}:[a-z0-9!._]{2,15}$/i.test(w) ? w.toUpperCase() : null));
  if (words.length && hits.every(Boolean)) return { symbols: [...new Set(hits)], via: "dict" };
  // 3) ask Workers AI
  if (!env.AI) return { symbols: [], via: "no-ai" };
  let lastErr = "";
  for (const model of AI_MODELS) {                 // first model that works wins
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: "system", content: AI_SYSTEM }, { role: "user", content: text }],
        max_tokens: 100, temperature: 0,
      });
      const raw = String(out.response ?? out.result?.response ?? "");
      // accept ["NYSE:KO"], NYSE:KO,NASDAQ:PEP, or any prose containing EXCHANGE:TICKER
      const symbols = (raw.toUpperCase().match(/\b[A-Z0-9_]{2,12}:[A-Z0-9!._]{1,20}/g) || []).map((x) => x.replace(/\.+$/, "")).slice(0, 5);
      return { symbols: [...new Set(symbols)], via: "ai " + model, raw };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { symbols: [], via: "ai-error " + lastErr };
}

// ---------------------------------------------------------------------------

async function handle(update, env) {
  // --- buttons ---------------------------------------------------------------
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    const ack = (t) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: t });
    const role = await roleOf(env, chatId, q.from?.id);
    if (role === "none") return ack();
    const data = String(q.data || "");

    // owner approves / rejects / removes a user
    if (/^(acc|rej|rm):/.test(data)) {
      if (role !== "owner") return ack("Только владелец");
      const [what, uid] = data.split(":");
      const users = await getUsers(env);
      const u = users[uid] || { name: uid };
      if (what === "acc") { users[uid] = { ...u, ok: true, since: Date.now() }; }
      else { delete users[uid]; }
      await saveUsers(env, users);
      await ack(what === "acc" ? "Разрешено" : "Убрано");
      await tg(env, "editMessageText", {
        chat_id: chatId, message_id: q.message.message_id,
        text: what === "acc" ? `✅ ${u.name} теперь может пользоваться ботом` : `🚫 ${u.name}: доступ ${what === "rej" ? "отклонён" : "убран"}`,
      });
      await tg(env, "sendMessage", { chat_id: uid, text: what === "acc"
        ? "✅ Доступ разрешён! Напиши название инструмента — биткоин, эпл, золото… — и через ~40 секунд придёт график. /help — что ещё умею."
        : "🚫 Владелец бота не дал доступ." }).catch(() => {});
      return;
    }
    if (data === "users") {
      if (role !== "owner") return ack("Только владелец");
      await ack();
      return sendUsers(env, chatId);
    }
    if (data.startsWith("pdel:") || data === "pdef") {
      if (!canConfigure(role)) return ack("Только владелец");
      const list = await getPresets(env);
      const next = data === "pdef" ? DEFAULT_PRESETS : list.filter((_, i) => i !== +data.slice(5));
      await savePresets(env, next);
      await ack("Готово");
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      return sendPresets(env, chatId);
    }
    if (!canConfigure(role) && /^(tog|per|rng|frm|to|en):/.test(data)) return ack("Настройки меняет только владелец");

    if (data === "help") {
      await ack();
      await tg(env, "sendMessage", { chat_id: chatId, text: HELP });
      return;
    }

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
      const r = await runWorkflow(env, true, symbols, { chat: chatId });
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
  if (!msg) return;
  const send = (t, extra = {}) => tg(env, "sendMessage", { chat_id: msg.chat.id, text: t, ...extra });
  const role = await roleOf(env, msg.chat.id, msg.from?.id);

  if (role === "none") {
    if (msg.chat.type !== "private") return;              // strangers' groups: silence
    const uid = String(msg.from.id);
    const name = userName(msg.from) || uid;
    const users = await getUsers(env);
    if (users[uid]?.asked && Date.now() - users[uid].asked < 3600000) {
      return send("⏳ Запрос уже у владельца бота, жди ответа.");
    }
    users[uid] = { name, asked: Date.now() };
    await saveUsers(env, users);
    await notifyOwners(env, `👤 ${name} (id ${uid}) хочет пользоваться ботом.`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Разрешить", callback_data: "acc:" + uid }, { text: "🚫 Отклонить", callback_data: "rej:" + uid }]] },
    });
    return send("👋 Это бот с графиками TradingView. Я отправил запрос владельцу — как только он разрешит, напишу тебе.");
  }
  const onlyOwner = () => send("⚙️ Настройки меняет только владелец бота. Тебе доступно: написать название инструмента (биткоин, эпл, золото…), /chart, /help.");

  // Voice message -> speech to text (Workers AI Whisper), then handled like typed text
  if (msg.voice || msg.audio) {
    const heard = await transcribe(env, msg.voice || msg.audio);
    if (!heard) return send("🎤 Не расслышал. Скажи ещё раз или напиши текстом: биткоин, эпл, золото…");
    msg.text = heard;
    await send(`🎤 Услышал: «${heard}»`);
  }
  if (!msg.text) return;

  const raw = msg.text.trim();
  const presets = await getPresets(env);
  const awaitKey = `await:${msg.chat.id}:${msg.from.id}`;

  // a preset button -> remember it, ask for the instrument
  const pressed = findPreset(presets, raw);
  if (pressed) {
    await env.SETTINGS.put(awaitKey, JSON.stringify(pressed), { expirationTtl: 600 });
    return send(`${pressed.name} (${presetText(pressed)}).\nКакой инструмент? Напиши название или тикер: Coca-Cola, Apple, биткоин, золото… Можно несколько через запятую.`,
      { reply_markup: { force_reply: true, input_field_placeholder: "например: Apple" } });
  }
  // the instrument after a preset button
  if (!raw.startsWith("/")) {
    let waiting = null;
    try { waiting = await env.SETTINGS.get(awaitKey, "json"); } catch (e) {}
    if (waiting) {
      await env.SETTINGS.delete(awaitKey);
      const q = parseRequest((waiting.spec || "") + " " + raw);   // preset + what the person typed
      const { symbols } = await resolveSymbols(env, q.rest || raw);
      if (!symbols.length) {
        await env.SETTINGS.put(awaitKey, JSON.stringify(waiting), { expirationTtl: 600 });
        return send("Не понял, какой это инструмент 🤔 Напиши ещё раз: Coca-Cola, Apple, биткоин, золото, NASDAQ:TSLA…");
      }
      const r = await runWorkflow(env, true, symbols.join(","), { ...q, chat: msg.chat.id });
      return send(r.ok ? `⏳ Делаю ${describe(symbols, q)}, пришлю примерно через минуту` : `⚠️ GitHub не запустил робота (${r.status})`);
    }
  }

  const alias = raw === BTN.chart ? "/chart" : raw === BTN.settings ? "/settings"
              : raw === BTN.on ? "/on" : raw === BTN.off ? "/off" : null;
  const parts = (alias || raw).split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/menu") {
    const kb = presetKeyboard(presets, role);
    if (!canConfigure(role)) {
      return send("👋 Нажми шаблон внизу (таймфрейм и индикаторы уже заданы) и напиши инструмент: Coca-Cola, Apple, биткоин…\nИли сразу текстом: «эпл дневной с ma 150». /help — подробнее.", { reply_markup: kb });
    }
    await send("Кнопки внизу: шаблоны (нажал → написал инструмент → график), 📊 График — твои инструменты сейчас, ⚙️ Настройки — всё остальное. Шаблоны редактируются через /presets.", { reply_markup: kb });
    const s = await getSettings(env);
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/help") return send(HELP);

  if (cmd === "/presets") {
    if (!canConfigure(role)) return onlyOwner();
    return sendPresets(env, msg.chat.id);
  }
  const pe = parsePresetEdit(raw);
  if (pe) {
    if (!canConfigure(role)) return onlyOwner();
    const list = (await getPresets(env)).filter((p) => p.name.toLowerCase() !== pe.name.toLowerCase());
    if (pe.add) {
      if (!pe.name) return send("Напиши так: добавь шаблон Дневной RSI: дневной rsi 14 чистый");
      list.push({ name: pe.name.slice(0, 40), spec: pe.spec });
    }
    await savePresets(env, list);
    await send(pe.add ? `✅ Шаблон «${pe.name}» добавлен: ${presetText({ spec: pe.spec })}` : `🗑 Шаблон «${pe.name}» удалён`, { reply_markup: presetKeyboard(list, role) });
    return sendPresets(env, msg.chat.id);
  }

  if (cmd === "/users") {
    if (role !== "owner") return onlyOwner();
    return sendUsers(env, msg.chat.id);
  }

  if (!canConfigure(role) && ["/settings", "/add", "/del", "/on", "/off", "/hours", "/period", "/range"].includes(cmd)) return onlyOwner();

  if (cmd === "/settings") {
    const s = await getSettings(env);
    return send(settingsText(env, s), { reply_markup: settingsKeyboard(env, s) });
  }

  if (cmd === "/add" || cmd === "/del") {
    const rest = parts.slice(1).join(" ").trim();
    if (!rest) return send(cmd === "/add" ? "Напиши инструмент, например: /add usdjpy или /add биткоин" : "Напиши инструмент, например: /del usdjpy");
    let { symbols } = await resolveSymbols(env, rest);
    if (!symbols.length) symbols = parts.slice(1).map((p) => normalize(env, p)).filter(Boolean);
    return send(...(await editList(env, cmd === "/add", symbols)));
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

  if (cmd !== "/chart") {
    if (cmd.startsWith("/")) return;                       // unknown command - ignore
    // "добавь в рассылку биткоин" / "убери из рассылки золото" -> edit the auto-send list
    const edit = parseListEdit(raw);
    if (edit) {
      if (!canConfigure(role)) return onlyOwner();
      const { symbols } = await resolveSymbols(env, edit.what);
      if (!symbols.length) return send(`Не понял, какой инструмент ${edit.add ? "добавить" : "убрать"} 🤔 Напиши, например: добавь в рассылку биткоин`);
      return send(...(await editList(env, edit.add, symbols)));
    }

    // Free text: "биткоин", "эпл и амазон", "apple дневной с ma 150" ... -> chart(s)
    const q = parseRequest(raw);
    const res = await resolveSymbols(env, q.rest || raw);
    console.log("resolve", JSON.stringify({ q, res }));
    const { symbols } = res;
    if (!symbols.length) {
      return send("Не понял, какой это инструмент 🤔\nНапиши название или тикер, например: биткоин, эпл, золото, нефть, NASDAQ:TSLA\nМожно с таймфреймом и индикатором: «эпл дневной с ma 150»");
    }
    const r = await runWorkflow(env, true, symbols.join(","), { ...q, chat: msg.chat.id });
    return send(r.ok ? `⏳ Делаю ${describe(symbols, q)}, пришлю примерно через минуту` : `⚠️ GitHub не запустил робота (${r.status})`);
  }

  const rest = parts.slice(1).join(" ").trim();
  if (!rest) {
    const s = await getSettings(env);
    return send("Какой график прислать?\nИли просто напиши название: биткоин, эпл, золото…", { reply_markup: chartKeyboard(env, s) });
  }
  const q = parseRequest(rest);
  let { symbols: wanted } = await resolveSymbols(env, q.rest || rest);
  if (!wanted.length) wanted = (q.rest || rest).split(/\s+/).map((p) => normalize(env, p)).filter(Boolean); // raw tickers like usdjpy
  const r = await runWorkflow(env, true, wanted.join(","), { ...q, chat: msg.chat.id });
  return send(r.ok
    ? `⏳ Делаю ${describe(wanted, q)}, пришлю примерно через минуту`
    : `⚠️ GitHub не запустил робота (${r.status}). Проверь GH_TOKEN в Cloudflare.\n${r.body.slice(0, 300)}`);
}

// Press "Run workflow" on GitHub, passing the remembered range.
async function runWorkflow(env, force, symbols = "", opts = {}) {
  const s = await getSettings(env);
  const extra = {};
  if (opts.interval) extra.interval = opts.interval;             // "1D", "60" - this run only
  if (opts.studies?.length) extra.studies = opts.studies.join(","); // "sma:150,rsi:14"
  if (opts.only) extra.only_studies = "true";
  if (opts.chat) extra.chat_id = String(opts.chat);                // reply into the chat that asked
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
        inputs: { force: force ? "true" : "false", symbols, view_hours: String(s.range), work_hours: workHours(s), ...extra },
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
