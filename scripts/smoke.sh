#!/usr/bin/env bash
# Starts the Worker locally with dummy secrets and checks /health and /mcp (initialize, tools/list).
# Apple is never called, so no real credentials are needed.
set -euo pipefail
PORT=8799
TOKEN=smoke-test-token
cat > .dev.vars <<VARS
ASC_ISSUER_ID=dummy-issuer
ASC_KEY_ID=DUMMYKEY
ASC_PRIVATE_KEY=dummy
MCP_BEARER_TOKEN=$TOKEN
VARS
npx wrangler dev --port "$PORT" --ip 127.0.0.1 > /tmp/wrangler-dev.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f .dev.vars' EXIT
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/health"; echo

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp")
[ "$code" = "401" ] || { echo "expected 401 without token, got $code"; cat /tmp/wrangler-dev.log; exit 1; }

mcp() {
  curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    -d "$1"
}
init=$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
echo "$init" | head -c 600; echo
echo "$init" | grep -q '"apphub-mcp"' || { echo "initialize failed"; cat /tmp/wrangler-dev.log; exit 1; }

tools=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for t in list_apps get_app list_app_store_versions list_builds get_build get_testflight_info list_subscriptions get_subscription_prices; do
  echo "$tools" | grep -q "\"$t\"" || { echo "missing tool $t"; echo "$tools" | head -c 2000; cat /tmp/wrangler-dev.log; exit 1; }
done
echo "smoke test OK: /mcp initialize + tools/list (8 tools)"
