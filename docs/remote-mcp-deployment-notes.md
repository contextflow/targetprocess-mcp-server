# Remote MCP Deployment Notes

Goal: deploy one shared Targetprocess MCP service so users can connect from Claude Web or similar clients without each person running or deploying the server locally.

## Current State

- The existing server is stdio-based.
- Stdio MCP works for local clients such as Claude Desktop or CLI-style MCP configs.
- Claude Web-style shared usage needs a hosted HTTPS MCP endpoint, typically using MCP Streamable HTTP transport.

## Recommended Architecture

1. Deploy one central HTTPS MCP endpoint.
   - Example shape: `https://mcp.example.com/targetprocess`
   - The service should expose MCP Streamable HTTP, not only stdio.
   - This repository now exposes the hosted endpoint at `MCP_PUBLIC_URL + MCP_PATH` (`/mcp` by default) through `nix run .#hosted`.

2. Keep shared configuration central.
   - Store non-secret configuration such as the Targetprocess base URL in the deployment environment.
   - Prefer per-user Targetprocess personal access tokens for write-capable use.
   - Optionally configure one service Targetprocess token for users who only need search/read plus attributed comments.

3. Let each user authenticate with their own credentials.
   - The hosted service acts as an OAuth authorization server for the MCP resource and delegates user sign-in to the organization OIDC provider.
   - Users save their own Targetprocess personal access token at `/account/targetprocess` after OIDC sign-in.
   - The account page links to the Targetprocess personal access token settings page derived from `TP_BASE_URL`.
   - The service validates the token against Targetprocess before saving it.
   - Users can choose the service token mode when `TP_SHARED_TOKEN` is configured; that mode only exposes read/search/get/list tools plus comments, and comments are prefixed with the authenticated OIDC email address.
   - Personal token users can disable write categories and set hourly create/comment limits from the account page.
   - Stored Targetprocess credentials are encrypted at rest with `TP_TOKEN_ENCRYPTION_KEY_B64`.

4. Resolve credentials per request.
   - Claude calls the shared MCP endpoint.
   - The service validates the MCP bearer token on every HTTP request.
   - The service loads that user’s stored Targetprocess credential.
   - The Targetprocess MCP tools run with that user’s Targetprocess permissions.
   - Results are returned to Claude.

5. Publish the connector.
   - Register the Claude organization connector as an OAuth client in `MCP_OAUTH_CLIENTS_JSON`.
   - If the Claude plan supports admin-managed connectors, publish the shared MCP URL there.
   - Gemini and Codex can be added later by adding their exact OAuth redirect URIs as additional registered clients.

## Implemented Hosted Mode

The hosted entrypoint is `src/http.ts` and is intentionally separate from the stdio entrypoint:

```sh
nix run .#hosted
```

Required environment:

```sh
TP_BASE_URL=https://your-instance.tpondemand.com
MCP_PUBLIC_URL=https://mcp.example.com
MCP_SIGNING_KEY_B64=<32 random bytes, base64>
TP_TOKEN_ENCRYPTION_KEY_B64=<32 random bytes, base64>
MCP_METRICS_BEARER_TOKEN=<metrics-scrape-token>
MCP_OAUTH_CLIENTS_JSON='[{"client_id":"claude-org","name":"Claude org connector","redirect_uris":["https://..."],"allowed_origins":["https://claude.ai"]}]'
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=<google-oauth-client-id>
OIDC_CLIENT_SECRET=<google-oauth-client-secret>
OIDC_ALLOWED_DOMAINS=<your-org-domain>
OIDC_ALLOWED_HOSTED_DOMAINS=<your-google-workspace-domain>
```

Optional environment:

- `MCP_PORT`: HTTP listen port, default `3000`.
- `MCP_PATH`: MCP endpoint path, default `/mcp`.
- `MCP_METRICS_PATH`: Prometheus metrics endpoint path, default `/metrics`.
- `MCP_METRICS_BEARER_TOKEN`: bearer token required to scrape metrics. Without it, metrics stay unavailable.
- `MCP_TRUST_PROXY_HEADERS`: set to `1` only when the service is reachable exclusively through a trusted reverse proxy; then audit logs use `X-Forwarded-For`/`X-Real-IP`.
- `MCP_RESOURCE`: OAuth resource/audience, default `MCP_PUBLIC_URL + MCP_PATH`.
- `MCP_ALLOWED_ORIGINS`: comma-separated extra HTTP origins accepted on MCP requests.
- `MCP_OAUTH_CLIENTS_JSON`: registered MCP OAuth clients. Each entry can set `access_token_ttl_seconds`; the default is 900 seconds. Use this for clients that do not reliably refresh active MCP sessions, for example `{"client_id":"codex-local","redirect_uris":["http://127.0.0.1/callback"],"access_token_ttl_seconds":28800}`.
- `OIDC_ALLOWED_HOSTED_DOMAINS`: comma-separated Google Workspace hosted domains required in the ID-token `hd` claim. Use this with `OIDC_ISSUER_URL=https://accounts.google.com` when you need Workspace membership, not just an email suffix.
- `OIDC_ALLOWED_GROUPS`: comma-separated required group names.
- `TP_TOKEN_STORE_PATH`: encrypted JSON token store path, default `/tmp/targetprocess-mcp-user-tokens.json`.
- `MCP_OAUTH_STATE_STORE_PATH`: OAuth authorization state, code, refresh-token, and account-review resume JSON store path. Defaults to `TP_TOKEN_STORE_PATH + ".oauth-state.json"`.
- `TP_SHARED_TOKEN`: optional service Targetprocess personal access token for read/search/get/list plus attributed comments.
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS`, `OIDC_ALLOWED_HOSTED_DOMAINS`, `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_JWKS_URI`: OIDC upstream login configuration. The explicit endpoint variables are optional when issuer discovery works.

### Registering Codex as an OAuth Client

The Codex client is registered on the hosted MCP server through `MCP_OAUTH_CLIENTS_JSON`. It is not configured only in `~/.codex/config.toml`; Codex local config must match a client ID that the server already knows.

For a Codex CLI client, add a `codex-local` entry to the server environment:

```sh
MCP_OAUTH_CLIENTS_JSON='[
  {
    "client_id": "claude-org",
    "name": "Claude org connector",
    "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
    "allowed_origins": ["https://claude.ai"]
  },
  {
    "client_id": "codex-local",
    "name": "Codex local",
    "redirect_uris": ["http://127.0.0.1/callback"],
    "access_token_ttl_seconds": 28800
  }
]'
```

`access_token_ttl_seconds` controls the short-lived bearer token returned to that client. The default is `900` seconds. Use a longer value for Codex if active MCP sessions get stuck at the 15-minute mark instead of refreshing cleanly. Refresh tokens are still issued and persisted separately under `MCP_OAUTH_STATE_STORE_PATH`.

After changing `MCP_OAUTH_CLIENTS_JSON`, restart the hosted MCP service. Then configure the local Codex CLI to use the same client ID and resource:

```sh
codex mcp remove targetprocess
codex mcp add targetprocess \
  --url https://mcp.example.com/mcp \
  --oauth-client-id codex-local \
  --oauth-resource https://mcp.example.com/mcp
codex mcp login targetprocess
```

For a temporary development tunnel, replace `https://mcp.example.com/mcp` with the full public tunnel resource. If the tunnel URL changes, update both the hosted server `MCP_PUBLIC_URL`/`MCP_RESOURCE` and the local Codex MCP entry.

For production, put `TP_TOKEN_STORE_PATH` and `MCP_OAUTH_STATE_STORE_PATH` on a persistent encrypted volume or replace the file-store implementations with a managed database/secret store. The current in-repo implementation is a single-instance encrypted credential file plus a single-instance OAuth state file.

Changing OIDC allowlist settings affects new OIDC callbacks. Already-issued MCP access tokens and refresh tokens remain usable until their configured expiry unless you rotate `MCP_SIGNING_KEY_B64` or clear `MCP_OAUTH_STATE_STORE_PATH`.

## Security Baseline

- Require HTTPS.
- Require authentication on every MCP request.
- Validate HTTP `Origin` headers.
- Encrypt stored user credentials.
- Keep `TP_SHARED_TOKEN` limited in Targetprocess, because every service-token user shares that Targetprocess principal for API authorization.
- Never log tokens, API keys, or raw authorization headers.
- Restrict outbound network access to the Targetprocess host.
- JSON audit logs are written to stdout for HTTP requests, security failures, request failures, and tool calls.
- Prometheus metrics cover request outcomes, auth/security failures, request failures by stage/reason, tool calls, rate-limit denials, and active sessions.
- Destructive tools such as ticket deletion are disabled by default and configurable per user.
- Do not rely on `User-Agent`, DNS, or `Origin` alone to decide whether a caller is Claude, Gemini, or Codex; those signals are spoofable. The enforceable boundary is the registered OAuth client allowlist plus organization OIDC policy.
- OAuth authorization state, authorization codes, refresh grants, and account-review resumes are persisted under `MCP_OAUTH_STATE_STORE_PATH`. MCP session maps and rate-limit counters are still process-local; multi-replica deployments need sticky sessions or a shared state store.

## Implementation Tasks

1. Done: Targetprocess token/base URL can be request scoped.
2. Done: Streamable HTTP MCP endpoint at `/mcp`.
3. Done: OAuth/OIDC broker with registered MCP client allowlist.
4. Done: encrypted per-user Targetprocess token onboarding.
5. Done: configurable destructive-tool policy and create/comment rate limits.
6. Done: token redaction is preserved, structured audit logging is emitted on stdout, and metrics are available for scraping.
7. Deploy behind the normal HTTPS ingress/reverse proxy.
8. Register the hosted MCP URL in Claude or provide it to users as the single connector URL.

## NixOS fail2ban

Keep fail2ban close to the systemd journal and match only the stable security event:

```nix
services.fail2ban = {
  enable = true;
  jails.targetprocess-mcp = {
    filter.Definition.failregex = ''^.*"event":"tp_mcp_security_failure".*"clientIp":"<HOST>".*$'';
    settings = {
      backend = "systemd";
      journalmatch = "_SYSTEMD_UNIT=targetprocess-mcp.service";
      maxretry = 8;
      findtime = "10m";
      bantime = "1h";
    };
  };
};
```

Run `nix flake check` before deploying changes.

## Failure Debugging

Use the structured `tp_mcp_request_failure` audit event to debug why hosted MCP usage fails. It includes stable fields such as `requestId`, `route`, `status`, `stage`, `reason`, `clientId`, `userEmail`, `toolName`, and sanitized Targetprocess request metadata (`targetprocessMethod`, `targetprocessPath`, `targetprocessStatus`). It intentionally does not log authorization headers, cookies, OAuth codes, access tokens, refresh tokens, Targetprocess personal tokens, raw tool arguments, request bodies, or Targetprocess response bodies.

Example journal filter:

```sh
journalctl -u targetprocess-mcp.service -o cat | jq 'select(.event == "tp_mcp_request_failure")'
```

Keep fail2ban or similar blocking automation tied to `tp_mcp_security_failure`; `tp_mcp_request_failure` is broader debugging telemetry and includes expected user/configuration failures.

## Useful References

- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
