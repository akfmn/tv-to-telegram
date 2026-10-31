"""
TradingView -> Telegram: screenshot of your chart (with your indicators).
Runs in GitHub Actions every 30 minutes. Your computer can be off.

Settings come from GitHub Secrets (Settings -> Secrets and variables -> Actions):
  TG_TOKEN            - bot token from @BotFather
  TG_CHAT_ID          - your chat id (number)
  CHART_URL           - link to your saved layout, e.g. https://www.tradingview.com/chart/AbCd1234/
  TV_SESSIONID        - "sessionid" cookie from tradingview.com
  TV_SESSIONID_SIGN   - "sessionid_sign" cookie from tradingview.com
Optional (Variables, not secrets):
  SYMBOL              - e.g. BINANCE:BTCUSDT (if empty, uses the symbol saved in the layout)
  INTERVAL            - default 5
  TZ_NAME             - default Asia/Jerusalem (used for the time in the caption)
  SEND_AS_FILE        - "1" = send as file (full quality), otherwise as photo
"""

import os
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
FORCE = env("FORCE", "false") == "true"          # manual run: ignore the window

TG_API = f"https://api.telegram.org/bot{TG_TOKEN}"
OUT = "chart.png"


def tg_text(text):
    requests.post(f"{TG_API}/sendMessage",
                  data={"chat_id": TG_CHAT_ID, "text": text}, timeout=30)


def tg_image(path, caption):
    method, field = ("sendDocument", "document") if SEND_AS_FILE else ("sendPhoto", "photo")
    with open(path, "rb") as f:
        r = requests.post(f"{TG_API}/{method}",
                          data={"chat_id": TG_CHAT_ID, "caption": caption},
                          files={field: ("chart.png", f, "image/png")}, timeout=60)
    if not r.ok:
        sys.exit(f"Telegram error: {r.status_code} {r.text}")


def build_url():
    url = CHART_URL.split("?")[0]
    if not url.endswith("/"):
        url += "/"
    params = [f"interval={INTERVAL}"]
    if SYMBOL:
        params.append(f"symbol={SYMBOL}")
    return url + "?" + "&".join(params)


def take_screenshot():
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

        page = ctx.new_page()
        page.goto(build_url(), wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("canvas", timeout=60000)
        time.sleep(10)  # let candles and indicators finish drawing

        # Did the login work? If not, the chart opens without your indicators.
        try:
            authed = page.evaluate("() => window.is_authenticated")
        except Exception:
            authed = None
        if authed is False:
            tg_text("⚠️ TradingView login expired — chart is without your indicators. "
                    "Update TV_SESSIONID / TV_SESSIONID_SIGN in GitHub Secrets.")

        # Close pop-ups/banners
        for _ in range(3):
            page.keyboard.press("Escape")
            time.sleep(0.3)
        page.mouse.move(5, 5)  # move cursor away so no crosshair on chart

        area = page.locator(".layout__area--center")
        if area.count() > 0:
            area.first.screenshot(path=OUT)
        else:
            page.screenshot(path=OUT)

        title = page.title()
        browser.close()
        return title


def in_work_hours():
    """True if now (in TZ_NAME) is inside WORK_HOURS.
    9 minutes of grace after the end, because GitHub often starts
    scheduled runs a few minutes late (so the 17:00 shot still goes out)."""
    if FORCE or not WORK_HOURS:
        return True
    start_s, end_s = WORK_HOURS.split("-")
    to_min = lambda s: int(s.split(":")[0]) * 60 + int(s.split(":")[1])
    now = datetime.now(ZoneInfo(TZ_NAME))
    m = now.hour * 60 + now.minute
    return to_min(start_s) <= m <= to_min(end_s) + 9


def main():
    if not in_work_hours():
        print(f"Outside {WORK_HOURS} ({TZ_NAME}) - nothing to send.")
        return
    try:
        title = take_screenshot()
    except Exception as e:
        tg_text(f"⚠️ Could not take the TradingView screenshot: {e}")
        raise
    now = datetime.now(ZoneInfo(TZ_NAME)).strftime("%d.%m %H:%M")
    label = SYMBOL or title.split(" ")[0]
    tg_image(OUT, f"{label} · {INTERVAL}m · {now}")


if __name__ == "__main__":
    main()
