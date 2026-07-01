# Security Review

Date: 2026-07-01

## Findings

- Runtime outbound HTTP is centralized in `src/tp.ts`. The only application fetch destinations are `TP_BASE_URL` API paths and `TP_BASE_URL/UploadFile.ashx`.
- `TP_TOKEN` is sent to Targetprocess as an `access_token` query parameter. This is redacted from local request URL logging, but it may still appear in Targetprocess-side access logs.
- `TP_DEBUG_HTTP=1` can log request bodies and Targetprocess error bodies. This should only be enabled in trusted local debugging sessions.
- Targetprocess fetches explicitly reject HTTP redirects, so a compromised or misconfigured endpoint cannot silently redirect a token-bearing request to another origin in the unjailed runtime.
- `npm audit` and `npm audit --omit=dev` reported zero known advisories for the locked dependency tree at review time.
- No obvious obfuscation was found in source files. The only source-level base64 handling is expected upload decoding in `addAttachedFile`.
- The Linux default Nix app previously used jail.nix `network`, which shares the host network namespace. It is now replaced with a no-network Node jail plus a tinyproxy allowlist proxy. macOS uses a Seatbelt profile through `/usr/bin/sandbox-exec` with direct network denied and the same tinyproxy Unix socket path. Proxy bootstrap is shell-only; Node.js is not used to launch or configure tinyproxy.

## Third-Party Endpoints And URLs

Runtime endpoints:

- `https://<TP_BASE_URL host>/api/v1/...`
- `https://<TP_BASE_URL host>/api/v2/...`
- `https://<TP_BASE_URL host>/UploadFile.ashx`

Repository and documentation URLs:

- `https://git.sr.ht/~alexdavid/jail.nix`
- `https://github.com/SerhiiMaksymiv/targetprocess-mcp-server`
- `https://github.com/SerhiiMaksymiv/targetprocess-mcp-server/issues`
- `https://www.targetprocess.com/`
- `https://vitest.dev/`
- `https://github.com/colinhacks/zod`

Dependency/package metadata URLs:

- Package tarball `resolved` URLs are under `https://registry.npmjs.org/`.
- Lockfile funding/sponsor metadata includes GitHub Sponsors, OpenCollective, Tidelift, and project-specific sponsor URLs. These are metadata only and are not used by the runtime server.

## Dependency Notes

Direct runtime dependencies are:

- `@modelcontextprotocol/sdk`
- `dotenv`
- `jsdom`
- `undici`
- `zod`

Notable transitive runtime capabilities:

- The MCP SDK brings HTTP server-related packages, but this server uses stdio transport only.
- JSDOM brings `undici` and proxy-capable packages, but this code constructs JSDOM instances from strings without resource loading options.
- `undici` is now direct only because the sandboxed runtime needs `ProxyAgent` to route global `fetch` through the private Unix socket.

## Sandbox And Proxy Model

The default Nix app starts tinyproxy outside the Node sandbox, configured with:

- `Listen 127.0.0.1`
- `ConnectPort 443`
- `FilterDefaultDeny Yes`
- a filter containing only the exact hostname from `TP_BASE_URL`
- no persistent log file

The wrapper validates `TP_BASE_URL` in shell before starting proxy processes. It rejects credentials, query strings, fragments, explicit ports, whitespace, unsupported hostname characters, and non-HTTPS URLs. It also requires a non-empty `TP_TOKEN` so failed secret retrieval cannot start a partly functional MCP that serves local tools but sends unauthenticated Targetprocess requests.

The wrapper then starts a private Unix socket bridge with `socat` and runs the MCP server without direct network access. On Linux this is enforced with bubblewrap through jail.nix. On macOS this is enforced with a Seatbelt profile through `/usr/bin/sandbox-exec`; that CLI is deprecated by Apple in favor of App Sandbox entitlements, but it is the practical native option for a Nix CLI wrapper. The sandboxed process receives `TP_PROXY_SOCKET` and uses `undici.ProxyAgent` with global `fetch` to connect through that socket. The proxy configuration directory is not mounted into the Linux jail and is not readable by the macOS sandboxed Node process. This keeps the OS-level egress path limited to the tinyproxy allowlist while preserving stdio MCP behavior.

The sandboxed process also receives a read-only CA bundle from `pkgs.cacert` via `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`. This is required for Node.js TLS verification after removing direct network access from the runtime.

The proxy wrapper fails closed if tinyproxy cannot bind, if the Unix socket bridge cannot be created, or if the macOS Seatbelt profile cannot be started. If tinyproxy or socat exits after startup, the sandboxed Node process still has no direct network path and subsequent Targetprocess calls fail instead of bypassing the proxy.
