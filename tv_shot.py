"""
TradingView -> Telegram: screenshots of your charts (with your indicators).
Runs in GitHub Actions on a schedule. Your computer can be off.

Settings come from GitHub Secrets (Settings -> Secrets and variables -> Actions):
  TG_TOKEN            - bot token from @BotFather
  TG_CHAT_ID          - who receives the pictures (your id, or a group/channel id)
  CHART_URL           - one or more charts, ONE PER LINE:
                          https://www.tradingview.com/chart/AbCd1234/
                          https://www.tradingview.com/chart/XyZ98765/
                        optionally followed by a symbol and/or interval:
                          https://www.tradingview.com/chart/AbCd1234/ BINANCE:ETHUSDT
                          https://www.tradingview.com/chart/AbCd1234/ NASDAQ:AAPL 15
  TV_SESSIONID        - "sessionid" cookie from tradingview.com
  TV_SESSIONID_SIGN   - "sessionid_sign" cookie from tradingview.com
Optional (Variables, not secrets):
  SYMBOL              - default symbol for lines without one (empty = what the layout has)
  INTERVAL            - default interval in minutes, default 5
  TZ_NAME             - default Asia/Jerusalem
  WORK_HOURS          - default 09:00-17:00 (local time), empty = any time
  WORK_DAYS           - default 1-5 (1=Mon ... 7=Sun), e.g. "1-5" or "7,1,2,3,4"
  VIEW_HOURS          - default 24: picture always shows exactly the last 24 hours (0 = as saved)
  SEND_AS_FILE        - "1" = send as files (full quality), otherwise as photos
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright


def env(name, default=None, required=False):
    v = os.environ.get(name, "").strip()
    if not v:
        if required:
            sys.exit(f"Missing setting: {name}")
        return default
    return v


TG_TOKEN = env("TG_TOKEN", required=True)
TG_CHAT_ID = env("CHAT_ID_OVERRIDE", "").strip() or env("TG_CHAT_ID", required=True)  # /chart from a private chat -> reply there
CHART_URL = env("CHART_URL", required=True)
SESSIONID = env("TV_SESSIONID", required=True)
SESSIONID_SIGN = env("TV_SESSIONID_SIGN", "")
SYMBOL = env("SYMBOL", "")
INTERVAL = env("INTERVAL", "5")
TZ_NAME = env("TZ_NAME", "Asia/Jerusalem")
SEND_AS_FILE = env("SEND_AS_FILE", "0") == "1"
WORK_HOURS = env("WORK_HOURS", "09:00-17:00")   # local time window, empty = always
WORK_DAYS = env("WORK_DAYS", "1-5")             # 1=Mon ... 7=Sun, empty = every day
VIEW_HOURS = float(env("VIEW_HOURS", "24"))      # always show exactly the last N hours (0 = as saved)
INTERVAL_OVERRIDE = env("INTERVAL_OVERRIDE", "").strip()   # "1D", "60", "15": timeframe for this run only
STUDIES = env("STUDIES", "").strip()                       # "sma:150,ema:200,rsi:14": indicators for this run only
ONLY_STUDIES = env("ONLY_STUDIES", "") == "1"              # hide your own indicators, show only STUDIES
WATERMARK = env("WATERMARK", "1") != "0"         # big currency code in the top-right corner
ALBUM = env("ALBUM", "0") == "1"                 # 1 = all charts in one album; 0 = separate messages
FORCE = env("FORCE", "false") == "true"          # manual run: ignore the window

TG_API = f"https://api.telegram.org/bot{TG_TOKEN}"


# ---------- schedule ----------

def parse_days(spec):
    days = set()
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = (int(x) for x in part.split("-"))
            days.update(range(a, b + 1))
        else:
            days.add(int(part))
    return days


def should_run_now():
    """Inside WORK_DAYS and WORK_HOURS (local time)?
    9 minutes of grace after the end, because GitHub often starts
    scheduled runs a few minutes late (so the 17:00 shot still goes out)."""
    if FORCE:
        return True, ""
    now = datetime.now(ZoneInfo(TZ_NAME))
    if WORK_DAYS and now.isoweekday() not in parse_days(WORK_DAYS):
        return False, f"day {now.isoweekday()} not in WORK_DAYS={WORK_DAYS}"
    if WORK_HOURS:
        start_s, end_s = WORK_HOURS.split("-")
        to_min = lambda s: int(s.split(":")[0]) * 60 + int(s.split(":")[1])
        m = now.hour * 60 + now.minute
        if not (to_min(start_s) <= m <= to_min(end_s) + 9):
            return False, f"{now:%H:%M} outside WORK_HOURS={WORK_HOURS}"
    return True, ""


# ---------- charts ----------

def parse_charts():
    """Each non-empty line: <url> [symbol] [interval]. Commas also split."""
    charts = []
    for raw in CHART_URL.replace(",", "\n").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        url, symbol, interval = parts[0], SYMBOL, INTERVAL
        for extra in parts[1:]:
            if extra.isdigit() or extra.upper() in ("D", "W", "M") or extra[:-1].isdigit():
                interval = extra
            else:
                symbol = extra
        charts.append({"url": url, "symbol": symbol, "interval": interval})
    if not charts:
        sys.exit("CHART_URL has no links")
    # /chart <symbol> from Telegram: same layout (first link), only the chosen symbols
    override = env("SYMBOLS_OVERRIDE", "")
    if override:
        base = charts[0]
        charts = [{"url": base["url"], "symbol": sym.strip(), "interval": base["interval"]}
                  for sym in override.split(",") if sym.strip()]
    if INTERVAL_OVERRIDE:              # "пришли дневной" -> every chart in this run uses that timeframe
        for c in charts:
            c["interval"] = norm_interval(INTERVAL_OVERRIDE)
    return charts


def norm_interval(iv):
    """1d/D/day -> 1D, 1h -> 60, 4h -> 240, 15 -> 15, 1w -> 1W (TradingView notation)."""
    t = iv.strip().upper().replace(" ", "")
    m = re.fullmatch(r"(\d*)(M|H|D|W|MO|MIN|S)?", t)
    if not m:
        return t
    n, unit = int(m.group(1) or 1), m.group(2)
    if unit in (None, "M", "MIN"):
        return str(n)
    if unit == "H":
        return str(n * 60)
    if unit == "S":
        return f"{n}S"
    if unit == "MO":
        return f"{n}M"
    return f"{n}{unit}"            # D / W


# ---------- extra indicators for one run ----------
# short code -> (TradingView study name, input key for the number)
STUDY_MAP = {
    "sma": ("Moving Average", "length"), "ma": ("Moving Average", "length"),
    "ema": ("Moving Average Exponential", "length"),
    "wma": ("Moving Average Weighted", "length"),
    "hma": ("Hull Moving Average", "length"),
    "rsi": ("Relative Strength Index", "length"),
    "atr": ("Average True Range", "length"),
    "bb": ("Bollinger Bands", "length"), "bollinger": ("Bollinger Bands", "length"),
    "macd": ("MACD", None), "vwap": ("VWAP", None), "volume": ("Volume", None), "vol": ("Volume", None),
    "stoch": ("Stochastic", None), "ichimoku": ("Ichimoku Cloud", None),
    "psar": ("Parabolic SAR", None), "supertrend": ("SuperTrend", None),
    "cci": ("Commodity Channel Index", "length"), "adx": ("Average Directional Index", None),
    "obv": ("On Balance Volume", None), "mfi": ("Money Flow Index", "length"),
    "williams": ("Williams %R", "length"), "donchian": ("Donchian Channels", "length"),
    "keltner": ("Keltner Channels", "length"), "pivots": ("Pivot Points Standard", None),
}


def parse_studies(spec):
    """'sma:150,ema:200,rsi' -> [{'name': 'Moving Average', 'inputs': {'length': 150}, 'label': 'MA 150'}, ...]"""
    out = []
    for item in spec.replace(";", ",").split(","):
        item = item.strip().lower()
        if not item:
            continue
        code, _, num = item.partition(":")
        if code not in STUDY_MAP:
            print(f"::warning::unknown indicator code '{code}' ignored")
            continue
        name, key = STUDY_MAP[code]
        inputs, label = {}, name
        if key and num.isdigit():
            inputs[key] = int(num)
            label = f"{code.upper()} {num}"
        elif code in ("sma", "ma", "ema", "wma", "hma", "rsi", "atr", "bb", "cci", "mfi"):
            label = code.upper()
        else:
            label = {"macd": "MACD", "vwap": "VWAP", "volume": "Volume", "vol": "Volume"}.get(code, name)
        out.append({"name": name, "inputs": inputs, "label": label})
    return out


ADD_STUDIES_JS = """
async ([studies, onlyThese]) => {
  const api = window.TradingViewApi;
  if (!api || !api.activeChart) return 'no TradingViewApi';
  const ch = api.activeChart();
  const log = [];
  if (onlyThese) {                     // hide the layout's own indicators for this picture
    try {
      for (const st of ch.getAllStudies()) {
        try { ch.getStudyById(st.id).setVisible(false); } catch (e) {}
      }
      log.push('hid ' + ch.getAllStudies().length);
    } catch (e) { log.push('hide-err ' + e.message); }
  }
  for (const s of studies) {
    let id = null, err = '';
    try { id = await ch.createStudy(s.name, false, false, s.inputs); }
    catch (e1) {
      err = e1.message;
      try { id = await ch.createStudy(s.name, false, false, Object.values(s.inputs)); err = ''; }
      catch (e2) { err += ' / ' + e2.message; }
    }
    log.push(s.name + (id ? ' ok' : ' FAIL ' + err));
  }
  await new Promise(r => setTimeout(r, 1500));   // let them calculate and draw
  return log.join('; ');
}
"""


def add_studies(page, studies):
    if not studies:
        return
    try:
        res = page.evaluate(ADD_STUDIES_JS, [studies, ONLY_STUDIES])
    except Exception as e:
        res = f"error {e}"
    print(f"::notice::studies -> {res}")


def build_url(c):
    url = c["url"].split("?")[0]
    if not url.endswith("/"):
        url += "/"
    params = [f"interval={c['interval']}"]
    if c["symbol"]:
        params.append(f"symbol={c['symbol']}")
    return url + "?" + "&".join(params)


SET_VIEW_JS = """
async ([hours, fallbackInterval, minBars]) => {
  const api = window.TradingViewApi;
  if (!api || !api.activeChart) return 'no TradingViewApi';
  const ch = api.activeChart();
  const val = v => (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v;
  // bar size in minutes
  let res = String((ch.resolution && ch.resolution()) || fallbackInterval || '5').toUpperCase();
  let mins = /^\\d+$/.test(res) ? +res
           : /^\\d*S$/.test(res) ? (parseInt(res) || 1) / 60
           : /^\\d*D$/.test(res) ? (parseInt(res) || 1) * 1440
           : /^\\d*W$/.test(res) ? (parseInt(res) || 1) * 10080 : 5;
  // hours -> bars; a daily chart asked for "48 hours" would be 2 candles, so keep at
  // least minBars candles on screen when a timeframe was chosen for this run
  const bars = Math.max(minBars || 10, Math.round(hours * 60 / mins));
  const w = ch._chartWidget || (ch.chartWidget && ch.chartWidget());
  // 1) Reset scales (= Alt+R): price axis back to Auto so every candle fits vertically,
  //    even if the saved layout had the price scale dragged/zoomed by hand.
  let reset = 'no';
  try { if (w.GUIResetScales) { w.GUIResetScales(); reset = 'gui'; } } catch (e) { reset = 'err ' + e.message; }
  if (reset !== 'gui') {
    try {
      const m = w.model();
      const mm = m.model ? m.model() : m;
      (mm.panes ? mm.panes() : []).forEach(p => {
        (p.leftPriceScales ? [...p.leftPriceScales(), ...p.rightPriceScales()] : [])
          .forEach(ps => { try { m.setPriceAutoScale(ps, p, true); } catch (e) {} });
      });
      reset = 'panes';
    } catch (e) { reset = 'err2 ' + e.message; }
  }
  // 2) Horizontal: exactly the last N hours
  const ts = w.model().timeScale();
  const width = val(ts.width());
  const spacing = width / (bars + 4);            // +4 bars of empty space on the right
  ts.setBarSpacing(spacing);
  ts.scrollToRealtime();
  await new Promise(r => setTimeout(r, 600));
  const v = ch.getVisibleRange ? ch.getVisibleRange() : null;
  return 'res=' + res + ' bars=' + bars + ' spacing=' + spacing.toFixed(2) + ' reset=' + reset +
         (v ? ' shown=' + ((v.to - v.from) / 3600).toFixed(1) + 'h' : '');
}
"""


def set_view(page):
    """Fixed zoom: the last VIEW_HOURS hours, no matter how you scrolled/zoomed."""
    for _ in range(10):  # API appears a moment after the chart
        try:
            if page.evaluate("() => !!(window.TradingViewApi && window.TradingViewApi.activeChart)"):
                break
        except Exception:
            pass
        time.sleep(1)
    try:
        min_bars = 200 if INTERVAL_OVERRIDE else 10
        res = page.evaluate(SET_VIEW_JS, [VIEW_HOURS, INTERVAL_OVERRIDE or INTERVAL, min_bars])
    except Exception as e:
        res = f"error {e}"
    print(f"::notice::set_view -> {res}")
    time.sleep(0.4)


QUOTES = ("USDT", "USDC", "BUSD", "USD", "EUR", "BTC")


def watermark_text(symbol):
    """OANDA:EURUSD -> EUR, FX:GBPUSD -> GBP, BINANCE:BTCUSDT -> BTC, NASDAQ:AAPL -> AAPL."""
    t = symbol.split(":")[-1].upper().replace("/", "")
    t = re.sub(r"[^A-Z0-9]", "", t)
    if len(t) == 6 and t.isalpha():          # forex pair: first currency
        return t[:3]
    for q in QUOTES:                          # crypto pair: strip the quote currency
        if len(t) > len(q) + 1 and t.endswith(q):
            return t[: -len(q)]
    return t


ADD_WATERMARK_JS = """
(text) => {
  document.querySelectorAll('.tg-watermark').forEach(e => e.remove());
  const host = document.querySelector('.chart-markup-table.pane .chart-gui-wrapper')
            || document.querySelector('.layout__area--center');
  if (!host) return 'no host';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const d = document.createElement('div');
  d.className = 'tg-watermark';
  d.textContent = text;
  d.style.cssText = 'position:absolute;top:10px;right:16px;z-index:9999;pointer-events:none;' +
    'font:700 52px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px;' +
    'color:rgba(255,255,255,.88);text-shadow:0 0 3px rgba(0,0,0,.9),0 0 8px rgba(0,0,0,.6);';
  host.appendChild(d);
  const r = d.getBoundingClientRect();
  return 'ok ' + text + ' at ' + Math.round(r.x) + ',' + Math.round(r.y);
}
"""


def add_watermark(page, chart):
    symbol = chart["symbol"]
    if not symbol:  # line without a symbol -> ask the chart which one it shows
        try:
            symbol = page.evaluate("() => window.TradingViewApi.activeChart().symbol()") or ""
        except Exception:
            symbol = ""
    text = watermark_text(symbol) if symbol else ""
    if not text:
        return
    try:
        res = page.evaluate(ADD_WATERMARK_JS, text)
    except Exception as e:
        res = f"error {e}"
    print(f"::notice::watermark -> {res}")


READY_JS = """
() => {
  try {
    const api = window.TradingViewApi;
    if (!api || !api.activeChart) return null;
    const ch = api.activeChart();
    const studies = ch.getAllStudies ? ch.getAllStudies().length : -1;
    let loading = false;
    try { const m = ch.chartModel ? ch.chartModel() : null;
          loading = !!(m && m.mainSeries && m.mainSeries().isLoading && m.mainSeries().isLoading()); } catch (e) {}
    return { studies, loading };
  } catch (e) { return null; }
}
"""


def wait_ready(page, max_wait=45):
    """Wait until the chart API is up, candles are loaded and the number of
    indicators has been stable for a few seconds. Returns indicator count."""
    t0 = time.time()
    last, stable_since = None, None
    while time.time() - t0 < max_wait:
        try:
            st = page.evaluate(READY_JS)
        except Exception:
            st = None
        if st and not st["loading"]:
            if st["studies"] != last:
                last, stable_since = st["studies"], time.time()
            elif time.time() - stable_since >= 2:
                break
        time.sleep(0.5)
    time.sleep(1.5)  # let the last indicator finish drawing
    return last if last is not None else -1


def shoot(page, chart, out_path, loaded=False):
    if not loaded:
        page.goto(build_url(chart), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("canvas", timeout=60000)
    studies = wait_ready(page)
    print(f"::notice::indicators loaded = {studies}")
    for _ in range(2):  # close pop-ups/banners
        page.keyboard.press("Escape")
        time.sleep(0.15)
    page.mouse.move(5, 5)  # move cursor away so no crosshair on chart
    add_studies(page, chart.get("studies") or [])
    if VIEW_HOURS > 0:
        set_view(page)
    # Hide floating toolbars over the chart (favorite drawing tools etc.)
    page.add_style_tag(content=".tv-floating-toolbar{display:none !important}")
    if WATERMARK:
        add_watermark(page, chart)
    time.sleep(0.3)
    area = page.locator(".layout__area--center")
    shot = {"path": out_path, "type": "jpeg", "quality": 88}  # jpeg: 5x smaller, faster upload
    if area.count() > 0:
        area.first.screenshot(**shot)
    else:
        page.screenshot(**shot)
    return page.title(), studies


def take_screenshots(charts):
    results, errors = [], []
    with sync_playwright() as p:
        try:
            # GitHub runners already have Google Chrome installed - fast start
            browser = p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        except Exception:
            browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 1600, "height": 900},
            device_scale_factor=2,
            locale="en-US",
            timezone_id=TZ_NAME,
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"),
        )
        cookies = [{"name": "sessionid", "value": SESSIONID,
                    "domain": ".tradingview.com", "path": "/", "secure": True, "httpOnly": True}]
        if SESSIONID_SIGN:
            cookies.append({"name": "sessionid_sign", "value": SESSIONID_SIGN,
                            "domain": ".tradingview.com", "path": "/", "secure": True, "httpOnly": True})
        ctx.add_cookies(cookies)

        # Read-only robot: never save anything back to your TradingView account.
        # Otherwise TradingView's autosave could overwrite your layout/drawings
        # with the (older) state the robot loaded, or switch your layout's symbol.
        def guard(route):
            req = route.request
            if req.method in ("POST", "PUT", "PATCH", "DELETE"):
                return route.abort()
            return route.continue_()
        ctx.route(re.compile(r"savechart|charts?-storage|line_tools|drawing"), guard)

        # Open every chart in its own tab first so they all load in parallel
        pages = []
        for chart in charts:
            pg = ctx.new_page()
            try:
                pg.goto(build_url(chart), wait_until="commit", timeout=60000)
            except Exception as e:
                print(f"::warning::goto failed, will retry: {e}")
            pages.append(pg)

        for i, chart in enumerate(charts):
            page = pages[i]
            out = f"chart_{i + 1}.jpg"
            try:
                page.bring_to_front()
                title, studies = shoot(page, chart, out, loaded=True)
                if studies == 0 and i == 0 and len(charts) > 1:
                    # First (cold) load sometimes misses the indicators - redo it once
                    print("::notice::first chart had no indicators, retrying once")
                    time.sleep(5)
                    title, studies = shoot(page, chart, out)
                if i == 0:
                    # Did the login work? If not, charts open without your indicators.
                    try:
                        authed = page.evaluate("() => window.is_authenticated")
                    except Exception:
                        authed = None
                    if authed is False:
                        tg_text("⚠️ TradingView login expired — charts are without your "
                                "indicators. Update TV_SESSIONID / TV_SESSIONID_SIGN in GitHub Secrets.")
                label = chart["symbol"] or title.split(" ")[0]
                results.append((out, label, chart["interval"] + (" · " + chart["tag"] if chart.get("tag") else "")))
            except Exception as e:
                errors.append(f"#{i + 1} {chart['url']}: {e}")
        browser.close()
    return results, errors


# ---------- telegram ----------

def pretty_interval(iv):
    """5 -> 5m, 60 -> 1h, 240 -> 4h, 1D -> 1D."""
    if iv.isdigit():
        n = int(iv)
        return f"{n // 60}h" if n % 60 == 0 and n >= 60 else f"{n}m"
    return iv


def tg_text(text):
    requests.post(f"{TG_API}/sendMessage",
                  data={"chat_id": TG_CHAT_ID, "text": text}, timeout=30)


def tg_send(results):
    now = datetime.now(ZoneInfo(TZ_NAME)).strftime("%d.%m %H:%M")
    def caption(label, iv):
        head, _, tag = iv.partition(" · ")          # "60 · MA 150" -> "1h · MA 150"
        return " · ".join(x for x in (label, pretty_interval(head), tag, now) if x)

    if len(results) == 1 or not ALBUM:
        # One message per chart, each with its own caption underneath
        method, field = ("sendDocument", "document") if SEND_AS_FILE else ("sendPhoto", "photo")
        for path, label, iv in results:
            with open(path, "rb") as f:
                r = requests.post(f"{TG_API}/{method}",
                                  data={"chat_id": TG_CHAT_ID, "caption": caption(label, iv)},
                                  files={field: (path, f, "image/jpeg")}, timeout=60)
            if not r.ok:
                sys.exit(f"Telegram error: {r.status_code} {r.text}")
        return

    # Several charts -> one album (Telegram allows up to 10 per album)
    kind = "document" if SEND_AS_FILE else "photo"
    for start in range(0, len(results), 10):
        chunk = results[start:start + 10]
        media, files = [], {}
        for j, (path, label, iv) in enumerate(chunk):
            key = f"img{j}"
            media.append({"type": kind, "media": f"attach://{key}", "caption": caption(label, iv)})
            files[key] = (path, open(path, "rb"), "image/jpeg")
        try:
            r = requests.post(f"{TG_API}/sendMediaGroup",
                              data={"chat_id": TG_CHAT_ID, "media": json.dumps(media)},
                              files=files, timeout=120)
        finally:
            for _, fh, _ in files.values():
                fh.close()
        if not r.ok:
            sys.exit(f"Telegram error: {r.status_code} {r.text}")


def main():
    ok, why = should_run_now()
    if not ok:
        print(f"Not sending: {why} ({TZ_NAME}).")
        return
    charts = parse_charts()
    studies = parse_studies(STUDIES)
    for c in charts:
        c["studies"] = studies
        c["tag"] = " · ".join(st["label"] for st in studies)
    try:
        results, errors = take_screenshots(charts)
    except Exception as e:
        tg_text(f"⚠️ Could not take the TradingView screenshots: {e}")
        raise
    if results:
        tg_send(results)
    if errors:
        tg_text("⚠️ Some charts failed:\n" + "\n".join(errors))
        if not results:
            sys.exit(1)


if __name__ == "__main__":
    main()
