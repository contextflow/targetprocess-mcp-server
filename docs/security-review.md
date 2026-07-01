# Security Review

Date: 2026-07-01

## Findings

- Runtime outbound HTTP is centralized in `src/tp.ts`. The only application fetch destinations are `TP_BASE_URL` API paths and `TP_BASE_URL/UploadFile.ashx`.
- `TP_TOKEN` is sent to Targetprocess as an `access_token` query parameter. This is redacted from local request URL logging, but it may still appear in Targetprocess-side access logs.
- `TP_DEBUG_HTTP=1` can log request bodies and Targetprocess error bodies. This should only be enabled in trusted local debugging sessions.
- Targetprocess fetches explicitly reject HTTP redirects, so a compromised or misconfigured endpoint cannot silently redirect a token-bearing request to another origin in the unjailed runtime.
- `npm audit` and `npm audit --omit=dev` reported zero known advisories for the locked dependency tree at review time.
- No obvious obfuscation was found in source files. The only source-level base64 handling is expected upload decoding in `addAttachedFile`.
- The default Nix app previously used jail.nix `network`, which shares the host network namespace. It is now replaced with a no-network Node jail plus a tinyproxy allowlist proxy. Proxy bootstrap is shell-only; Node.js is not used to launch or configure tinyproxy.

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
- `undici` is now direct only because the jailed runtime needs `ProxyAgent` to route global `fetch` through the private Unix socket.

## Jail And Proxy Model

The default Nix app starts tinyproxy outside the Node jail, configured with:

- `Listen 127.0.0.1`
- `ConnectPort 443`
- `FilterDefaultDeny Yes`
- a filter containing only the exact hostname from `TP_BASE_URL`
- no persistent log file

The wrapper validates `TP_BASE_URL` in shell before starting proxy processes. It rejects credentials, query strings, fragments, explicit ports, whitespace, unsupported hostname characters, and non-HTTPS URLs.

The wrapper then starts a private Unix socket bridge with `socat` and runs the MCP server in bubblewrap without direct network access. The jailed process receives `TP_PROXY_SOCKET` and uses `undici.ProxyAgent` with global `fetch` to connect through that socket. The proxy configuration directory is not mounted into the jail; only the socket directory is mounted read-only. This keeps the OS-level egress path limited to the tinyproxy allowlist while preserving stdio MCP behavior.

The proxy wrapper fails closed if tinyproxy cannot bind or if the Unix socket bridge cannot be created. If tinyproxy or socat exits after startup, the jailed Node process still has no direct network namespace and subsequent Targetprocess calls fail instead of bypassing the proxy.
