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
TG_CHAT_ID = env("TG_CHAT_ID", required=True)
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
    return charts


def build_url(c):
    url = c["url"].split("?")[0]
    if not url.endswith("/"):
        url += "/"
    params = [f"interval={c['interval']}"]
    if c["symbol"]:
        params.append(f"symbol={c['symbol']}")
    return url + "?" + "&".join(params)


SET_VIEW_JS = """
async ([hours, fallbackInterval]) => {
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
  const bars = Math.max(10, Math.round(hours * 60 / mins));
  const w = ch._chartWidget || (ch.chartWidget && ch.chartWidget());
  const ts = w.model().timeScale();
  const width = val(ts.width());
  const spacing = width / (bars + 4);            // +4 bars of empty space on the right
  ts.setBarSpacing(spacing);
  ts.scrollToRealtime();
  await new Promise(r => setTimeout(r, 1200));
  const v = ch.getVisibleRange ? ch.getVisibleRange() : null;
  return 'res=' + res + ' bars=' + bars + ' spacing=' + spacing.toFixed(2) +
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
        res = page.evaluate(SET_VIEW_JS, [VIEW_HOURS, INTERVAL])
    except Exception as e:
        res = f"error {e}"
    print(f"::notice::set_view -> {res}")
    time.sleep(1)


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
            elif time.time() - stable_since >= 4:
                break
        time.sleep(1)
    time.sleep(3)  # let the last indicator finish drawing
    return last if last is not None else -1


def shoot(page, chart, out_path):
    page.goto(build_url(chart), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("canvas", timeout=60000)
    studies = wait_ready(page)
    print(f"::notice::{chart['symbol'] or 'chart'}: {studies} indicators, waited for data")
    for _ in range(3):  # close pop-ups/banners
        page.keyboard.press("Escape")
        time.sleep(0.3)
    page.mouse.move(5, 5)  # move cursor away so no crosshair on chart
    if VIEW_HOURS > 0:
        set_view(page)
    # Hide floating toolbars over the chart (favorite drawing tools etc.)
    page.add_style_tag(content=".tv-floating-toolbar{display:none !important}")
    if WATERMARK:
        add_watermark(page, chart)
    time.sleep(0.3)
    area = page.locator(".layout__area--center")
    if area.count() > 0:
        area.first.screenshot(path=out_path)
    else:
        page.screenshot(path=out_path)
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

        page = ctx.new_page()

        for i, chart in enumerate(charts):
            out = f"chart_{i + 1}.png"
            try:
                title, studies = shoot(page, chart, out)
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
                results.append((out, label, chart["interval"]))
            except Exception as e:
                errors.append(f"#{i + 1} {chart['url']}: {e}")
        browser.close()
    return results, errors


# ---------- telegram ----------

def tg_text(text):
    requests.post(f"{TG_API}/sendMessage",
                  data={"chat_id": TG_CHAT_ID, "text": text}, timeout=30)


def tg_send(results):
    now = datetime.now(ZoneInfo(TZ_NAME)).strftime("%d.%m %H:%M")
    caption = lambda label, iv: f"{label} · {iv}m · {now}" if iv.isdigit() else f"{label} · {iv} · {now}"

    if len(results) == 1 or not ALBUM:
        # One message per chart, each with its own caption underneath
        method, field = ("sendDocument", "document") if SEND_AS_FILE else ("sendPhoto", "photo")
        for path, label, iv in results:
            with open(path, "rb") as f:
                r = requests.post(f"{TG_API}/{method}",
                                  data={"chat_id": TG_CHAT_ID, "caption": caption(label, iv)},
                                  files={field: (path, f, "image/png")}, timeout=60)
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
            files[key] = (path, open(path, "rb"), "image/png")
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
