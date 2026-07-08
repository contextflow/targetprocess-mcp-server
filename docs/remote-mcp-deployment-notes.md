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
   - This repository now exposes the hosted endpoint at `MCP_PUBLIC_URL + MCP_PATH` (`/mcp` by default) through `npm run start:http` after `npm run build`.

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
npm run build
npm run start:http
```

Required environment:

```sh
TP_BASE_URL=https://your-instance.tpondemand.com
MCP_PUBLIC_URL=https://mcp.example.com
MCP_SIGNING_KEY_B64=<32 random bytes, base64>
TP_TOKEN_ENCRYPTION_KEY_B64=<32 random bytes, base64>
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
- `MCP_RESOURCE`: OAuth resource/audience, default `MCP_PUBLIC_URL + MCP_PATH`.
- `MCP_ALLOWED_ORIGINS`: comma-separated extra HTTP origins accepted on MCP requests.
- `OIDC_ALLOWED_HOSTED_DOMAINS`: comma-separated Google Workspace hosted domains required in the ID-token `hd` claim. Use this with `OIDC_ISSUER_URL=https://accounts.google.com` when you need Workspace membership, not just an email suffix.
- `OIDC_ALLOWED_GROUPS`: comma-separated required group names.
- `TP_TOKEN_STORE_PATH`: encrypted JSON token store path, default `/tmp/targetprocess-mcp-user-tokens.json`.
- `MCP_OAUTH_STATE_STORE_PATH`: OAuth authorization state, code, refresh-token, and account-review resume JSON store path. Defaults to `TP_TOKEN_STORE_PATH + ".oauth-state.json"`.
- `TP_SHARED_TOKEN`: optional service Targetprocess personal access token for read/search/get/list plus attributed comments.
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS`, `OIDC_ALLOWED_HOSTED_DOMAINS`, `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_JWKS_URI`: OIDC upstream login configuration. The explicit endpoint variables are optional when issuer discovery works.

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
- Add audit logs for user, tool name, target entity ID, timestamp, and success/failure.
- Destructive tools such as ticket deletion are disabled by default and configurable per user.
- Do not rely on `User-Agent`, DNS, or `Origin` alone to decide whether a caller is Claude, Gemini, or Codex; those signals are spoofable. The enforceable boundary is the registered OAuth client allowlist plus organization OIDC policy.
- OAuth authorization state, authorization codes, refresh grants, and account-review resumes are persisted under `MCP_OAUTH_STATE_STORE_PATH`. MCP session maps and rate-limit counters are still process-local; multi-replica deployments need sticky sessions or a shared state store.

## Implementation Tasks

1. Done: Targetprocess token/base URL can be request scoped.
2. Done: Streamable HTTP MCP endpoint at `/mcp`.
3. Done: OAuth/OIDC broker with registered MCP client allowlist.
4. Done: encrypted per-user Targetprocess token onboarding.
5. Done: configurable destructive-tool policy and create/comment rate limits.
6. Partial: token redaction is preserved; structured audit logging is still a follow-up.
7. Deploy behind the normal HTTPS ingress/reverse proxy.
8. Register the hosted MCP URL in Claude or provide it to users as the single connector URL.

## Useful References

- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
