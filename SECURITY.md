# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

To report a security vulnerability, please open a [GitHub issue](https://github.com/SerhiiMaksymiv/targetprocess-mcp-server/issues) with the label `security`. For sensitive disclosures, email the maintainer directly rather than posting publicly.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix, if available

You can expect an initial response within 5 business days.

## Security Considerations

### API Token Handling

The stdio server authenticates to Targetprocess using a token set via the `TP_TOKEN` environment variable. The token is appended as a query parameter on outbound Targetprocess API requests.

The hosted HTTP server does not use a shared Targetprocess token. Each organization user signs in through OIDC and stores their own Targetprocess personal access token through `/account/targetprocess`. The token is validated before it is saved, stored encrypted at rest, and never rendered back through the account page.

- **Never commit `.env` files** or API tokens to source control.
- Use `.env.example` as a template; keep actual credentials in `.env` (git-ignored).
- Rotate the `TP_TOKEN` if it is accidentally exposed.
- Request URLs logged by the server redact `access_token`. Full request/response debugging is disabled unless `TP_DEBUG_HTTP=1` is set.

### Environment Variables

All sensitive configuration (`TP_TOKEN`, `TP_BASE_URL`, `TP_OWNER_ID`, `TP_PROJECT_ID`, `TP_TEAM_ID`) is loaded from environment variables at startup for stdio mode. Hosted mode additionally requires OAuth/OIDC secrets and encryption/signing keys such as `OIDC_CLIENT_SECRET`, `MCP_SIGNING_KEY_B64`, and `TP_TOKEN_ENCRYPTION_KEY_B64`. Ensure these are managed securely in your deployment environment (e.g., secrets manager, CI/CD secrets, not plain-text config files).

`TP_BASE_URL` must be an `https://` URL using the default HTTPS port 443. The jailed Nix launcher also rejects credentials, query strings, fragments, whitespace, explicit ports, and unsupported hostname characters before starting the proxy.

### Stdio Transport And Nix Sandboxing

The default MCP server communicates over stdio. It does not open any network ports and is not directly reachable over a network, which limits its attack surface to the process that spawns it (typically an MCP client such as Claude Desktop or Claude Code).

Hosted mode is opt-in via `npm run start:http` after build. It exposes a Streamable HTTP MCP endpoint and must be deployed behind HTTPS. The hosted endpoint validates `Host`, forwarded HTTPS, `Origin`, MCP bearer token issuer/audience/expiry, OAuth client registration, and MCP session ownership on each request.

The Nix flake default app wraps the server in an OS sandbox. On Linux it uses [jail.nix](https://git.sr.ht/~alexdavid/jail.nix) with bubblewrap. On macOS it uses the built-in Seatbelt sandbox through `/usr/bin/sandbox-exec`. The default app starts a local tinyproxy allowlist proxy outside the sandbox, exposes it to Node through a private Unix socket directory, and only allows HTTPS CONNECT to the exact host from `TP_BASE_URL` on port 443. The launcher fails closed if tinyproxy, the socket bridge, or the macOS Seatbelt profile cannot be started.

The `unjailed` flake app and npm package run as a normal Node process. They still validate outbound Targetprocess URLs in process and reject HTTP redirects, but they do not provide OS-level egress filtering.

Hosted mode should be deployed with equivalent network egress policy at the container, VM, Kubernetes, or proxy layer. The in-process Targetprocess URL checks still apply, but hosted Node is not wrapped by the local stdio Nix sandbox.

### Input Validation

All tool inputs are validated with [Zod](https://github.com/colinhacks/zod) schemas before reaching the Targetprocess API. Nonetheless, the server operates with whatever permissions the `TP_TOKEN` grants — apply the principle of least privilege when generating API tokens in Targetprocess.

### Dependency Updates

Keep dependencies up to date to pick up security patches. Run `npm audit` periodically to identify known vulnerabilities in the dependency tree.

## Known Limitations

- Stdio `TP_TOKEN` and hosted personal access token fallback credentials are passed as URL query parameters, which may appear in HTTP server access logs on the Targetprocess side. Hosted Frontdoor credentials use the `apptio-opentoken` header instead.
- No outbound request signing or mutual TLS is implemented; the server relies entirely on HTTPS and token-based auth provided by the Targetprocess platform.
- Hosted mode's built-in encrypted file token store is single-instance storage. Multi-replica deployments should replace it with a shared database or secret-store implementation and use shared OAuth/session state or sticky sessions.
- Restrict hosted OAuth clients with `MCP_OAUTH_CLIENTS_JSON`; do not treat `User-Agent` or `Origin` as proof that the caller is Claude, Gemini, or Codex.
