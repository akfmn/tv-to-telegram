#!/usr/bin/env bash
# Deploys telegram-worker/worker.js to Cloudflare without the browser.
# Keeps every existing binding (KV, AI, vars) and all secrets untouched.
# Needs: CLOUDFLARE_API_TOKEN (Workers Scripts: Edit), CLOUDFLARE_ACCOUNT_ID
set -euo pipefail
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?}"
SCRIPT="${CF_WORKER_NAME:-tv-chart-bot}"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?}")

# 0) is the token itself fine? (prints only status and lengths, never the values)
tok="${CLOUDFLARE_API_TOKEN}"
echo "token length: ${#tok}, account id length: ${#ACCOUNT}"
case "$tok" in *[[:space:]]*) echo "::warning::token contains whitespace/newline - re-paste it without spaces";; esac
curl -sS -H "Authorization: Bearer ${tok//[$'\r\n ']/}" https://api.cloudflare.com/client/v4/user/tokens/verify \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("token verify:", "OK, status " + d["result"]["status"] if d.get("success") else "FAILED " + json.dumps(d.get("errors")))'
AUTH=(-H "Authorization: Bearer ${tok//[$'\r\n ']/}")

# 1) current bindings (secrets come back without values and are kept via keep_bindings)
settings=$(curl -sS "${AUTH[@]}" "$API/settings")
echo "$settings" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("success"): sys.exit("settings failed: "+json.dumps(d.get("errors")))
r=d["result"]
b=[x for x in r.get("bindings",[]) if x.get("type")!="secret_text"]
meta={"main_module":"worker.js","bindings":b,"keep_bindings":["secret_text"],
      "compatibility_date":r.get("compatibility_date") or "2024-09-23",
      "compatibility_flags":r.get("compatibility_flags") or []}
if r.get("observability"): meta["observability"]=r["observability"]
json.dump(meta,open("metadata.json","w"))
print("bindings kept:", ", ".join(x["type"] + ":" + x["name"] for x in b))
'

# 2) upload the new code with the same bindings
res=$(curl -sS "${AUTH[@]}" -X PUT "$API" \
  -F 'metadata=@metadata.json;type=application/json' \
  -F 'worker.js=@telegram-worker/worker.js;type=application/javascript+module')
echo "$res" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("success"): sys.exit("deploy failed: "+json.dumps(d.get("errors")))
print("deployed, etag", d["result"].get("etag","?")[:12])
'
rm -f metadata.json

# 3) tell Telegram about commands/webhook (idempotent)
curl -sS "https://$SCRIPT.kofman-oleksii.workers.dev/setup"; echo
