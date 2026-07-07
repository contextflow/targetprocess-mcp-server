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
   - Do not configure a single shared Targetprocess API token for all users.

3. Let each user authenticate with their own credentials.
   - The hosted service acts as an OAuth authorization server for the MCP resource and delegates user sign-in to the organization OIDC provider.
   - Users register their own Targetprocess token at `/account/targetprocess` after OIDC sign-in.
   - Stored Targetprocess tokens are encrypted at rest with `TP_TOKEN_ENCRYPTION_KEY_B64`.

4. Resolve credentials per request.
   - Claude calls the shared MCP endpoint.
   - The service validates the MCP bearer token on every HTTP request.
   - The service loads that user’s stored Targetprocess token.
   - The Targetprocess MCP tools run with that user’s token.
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
OIDC_ISSUER_URL=https://idp.example.com
OIDC_CLIENT_ID=<oidc-client-id>
OIDC_CLIENT_SECRET=<oidc-client-secret>
OIDC_ALLOWED_DOMAINS=example.com
```

Optional environment:

- `MCP_PORT`: HTTP listen port, default `3000`.
- `MCP_PATH`: MCP endpoint path, default `/mcp`.
- `MCP_RESOURCE`: OAuth resource/audience, default `MCP_PUBLIC_URL + MCP_PATH`.
- `MCP_ALLOWED_ORIGINS`: comma-separated extra HTTP origins accepted on MCP requests.
- `OIDC_ALLOWED_GROUPS`: comma-separated required group names.
- `TP_TOKEN_STORE_PATH`: encrypted JSON token store path, default `/tmp/targetprocess-mcp-user-tokens.json`.
- `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_JWKS_URI`: use these to bypass OIDC discovery.

For production, put `TP_TOKEN_STORE_PATH` on a persistent encrypted volume or replace the `TargetprocessTokenStore` implementation with a managed database/secret store. The current in-repo implementation is a single-instance encrypted file store.

## Security Baseline

- Require HTTPS.
- Require authentication on every MCP request.
- Validate HTTP `Origin` headers.
- Encrypt stored user tokens.
- Never log tokens or raw authorization headers.
- Restrict outbound network access to the Targetprocess host.
- Add audit logs for user, tool name, target entity ID, timestamp, and success/failure.
- Consider role-gating destructive tools such as delete operations.
- Do not rely on `User-Agent`, DNS, or `Origin` alone to decide whether a caller is Claude, Gemini, or Codex; those signals are spoofable. The enforceable boundary is the registered OAuth client allowlist plus organization OIDC policy.
- The in-memory OAuth authorization-code, refresh-token, and MCP session maps are suitable for one service instance. Multi-replica deployments need sticky sessions or a shared state store.

## Implementation Tasks

1. Done: Targetprocess token/base URL can be request scoped.
2. Done: Streamable HTTP MCP endpoint at `/mcp`.
3. Done: OAuth/OIDC broker with registered MCP client allowlist.
4. Done: encrypted per-user Targetprocess token onboarding.
5. Partial: token redaction is preserved; structured audit logging is still a follow-up.
6. Deploy behind the normal HTTPS ingress/reverse proxy.
7. Register the hosted MCP URL in Claude or provide it to users as the single connector URL.

## Useful References

- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
