#!/usr/bin/env bash
set -euo pipefail

PUBLIC_URL="${MCP_PUBLIC_URL:?Set MCP_PUBLIC_URL to the public HTTPS URL for this hosted dev server}"
PORT="${MCP_PORT:-3000}"
SIGNING_KEY="${MCP_DEV_SIGNING_KEY_FILE:-/tmp/targetprocess-mcp-dev-signing-key.b64}"
TOKEN_KEY="${MCP_DEV_TOKEN_KEY_FILE:-/tmp/targetprocess-mcp-dev-token-key.b64}"
TOKEN_STORE="${TP_TOKEN_STORE_PATH:-/tmp/targetprocess-mcp-dev-user-tokens.json}"
WEB_ACCESS_TOKEN_TTL_SECONDS="${MCP_WEB_ACCESS_TOKEN_TTL_SECONDS:-900}"
CLI_ACCESS_TOKEN_TTL_SECONDS="${MCP_CLI_ACCESS_TOKEN_TTL_SECONDS:-28800}"

if [ ! -s "$SIGNING_KEY" ]; then
  head -c 32 /dev/urandom | base64 > "$SIGNING_KEY"
  chmod 600 "$SIGNING_KEY"
fi

if [ ! -s "$TOKEN_KEY" ]; then
  head -c 32 /dev/urandom | base64 > "$TOKEN_KEY"
  chmod 600 "$TOKEN_KEY"
fi

if [ -n "${OIDC_CLIENT_JSON:-}" ]; then
  OIDC_CLIENT_ID="$(jq -r '.web.client_id' "$OIDC_CLIENT_JSON")"
  OIDC_CLIENT_SECRET="$(jq -r '.web.client_secret' "$OIDC_CLIENT_JSON")"
elif [ -z "${OIDC_CLIENT_ID:-}" ] || [ -z "${OIDC_CLIENT_SECRET:-}" ]; then
  echo "Set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or set OIDC_CLIENT_JSON to a Google OAuth client JSON file." >&2
  exit 1
fi

export TP_DEBUG_HTTP="${TP_DEBUG_HTTP:-1}"
export TP_BASE_URL="${TP_BASE_URL:?Set TP_BASE_URL to your Targetprocess HTTPS base URL}"
export TP_PROJECT_ID="${TP_PROJECT_ID:-}"
export TP_TEAM_ID="${TP_TEAM_ID:-}"
export TP_SHARED_TOKEN="${TP_SHARED_TOKEN:-}"
export MCP_PUBLIC_URL="$PUBLIC_URL"
export MCP_PORT="$PORT"
export MCP_PATH="${MCP_PATH:-/mcp}"
export MCP_REQUIRE_HTTPS="${MCP_REQUIRE_HTTPS:-0}"
export MCP_ALLOWED_ORIGINS="${MCP_ALLOWED_ORIGINS:-https://claude.ai,http://localhost:3333,https://chatgpt.com}"
export MCP_SIGNING_KEY_B64="$(cat "$SIGNING_KEY")"
export TP_TOKEN_ENCRYPTION_KEY_B64="$(cat "$TOKEN_KEY")"
export TP_TOKEN_STORE_PATH="$TOKEN_STORE"
if [ -z "${MCP_OAUTH_CLIENTS_JSON:-}" ]; then
  # Browser-hosted clients can refresh through their hosted session. Local CLI
  # clients are more likely to keep using an already-open MCP connection, so
  # give them a longer access-token lifetime while refresh-token persistence
  # remains enabled server-side.
  MCP_OAUTH_CLIENTS_JSON="$(printf '[{"client_id":"claude-org","name":"ClaudeOrgConnector","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"allowed_origins":["https://claude.ai"],"scopes":["mcp:tools"],"access_token_ttl_seconds":%s},{"client_id":"chatgpt-dev","name":"ChatGPTDev","redirect_uris":["https://chatgpt.com/connector/oauth/EI4DtnLdLTcS"],"allowed_origins":["https://chatgpt.com"],"scopes":["mcp:tools"],"access_token_ttl_seconds":%s},{"client_id":"codex-local","name":"CodexLocal","redirect_uris":["http://127.0.0.1/callback","http://localhost/callback"],"allowed_origins":[],"scopes":["mcp:tools"],"access_token_ttl_seconds":%s}]' "$WEB_ACCESS_TOKEN_TTL_SECONDS" "$WEB_ACCESS_TOKEN_TTL_SECONDS" "$CLI_ACCESS_TOKEN_TTL_SECONDS")"
fi
export MCP_OAUTH_CLIENTS_JSON
export OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-https://accounts.google.com}"
export OIDC_CLIENT_ID
export OIDC_CLIENT_SECRET
export OIDC_SCOPES="${OIDC_SCOPES:-openid,email,profile}"
export OIDC_ALLOWED_DOMAINS="${OIDC_ALLOWED_DOMAINS:?Set OIDC_ALLOWED_DOMAINS to the allowed email domain list}"
export OIDC_ALLOWED_HOSTED_DOMAINS="${OIDC_ALLOWED_HOSTED_DOMAINS:?Set OIDC_ALLOWED_HOSTED_DOMAINS to the allowed Google Workspace hosted-domain list}"

exec nix run nixpkgs#nodejs_22 -- build/http.js
