# Targetprocess MCP Setup

Use `examples/targetprocess.mcp.json` as a generic MCP `mcpServers` config template.

## Required Bootstrap Values

- `TP_BASE_URL`: your Targetprocess instance URL, for example `https://your-instance.tpondemand.com`
- `TP_TOKEN`: create this in Targetprocess under settings for authentication/security access tokens.

Do not commit a real token. Keep it in your MCP client's secret/env config.

MCP JSON config files do not evaluate shell expressions. A value such as
`"$(password-manager targetprocess-token)"` is passed literally unless the MCP
client itself documents shell expansion. If the token comes from a password
manager, either export `TP_TOKEN` before starting the MCP client or use a small
shell wrapper as the MCP command.

The jailed launcher fails closed when `TP_TOKEN` is empty. This is intentional:
tool discovery and `get_version` do not need Targetprocess, so allowing startup
with an empty token would make the MCP look healthy while real API calls fail.

## Codex Setup

Codex stores MCP servers in `~/.codex/config.toml`. A setup for a local checkout
using `gopass` can look like this:

```toml
[mcp_servers.targetprocess]
command = "bash"
args = ["-lc", 'set -e; token="$(gopass Web/targetprocess-token)"; TP_BASE_URL=https://your-instance.tpondemand.com TP_TOKEN="$token" exec nix run path:/path/to/targetprocess-mcp-server']
```

The `set -e; token="$(...)"; ... exec nix run ...` shape matters. It resolves
the secret before starting the MCP and stops immediately if the password manager
cannot decrypt it. Do not write this as a single environment assignment such as
`TP_TOKEN="$(gopass ...)" exec nix run ...`: in some shells a failed command
substitution can still leave `TP_TOKEN` empty and continue to start the server.

Before starting Codex, test the same secret command from the same desktop or
terminal environment:

```bash
gopass Web/targetprocess-token >/dev/null
```

If that command opens a pinentry prompt or fails with a pinentry/TTY error, fix
the password-manager session first. Codex launches MCP servers non-interactively,
so `gopass` must be able to decrypt without relying on a prompt attached to the
MCP process.

## Discover Remaining Values

Start the server with only `TP_BASE_URL` and `TP_TOKEN`, then use these MCP tools:

- `get_logged_in_user`: copy the logged-in user's `Id` to `TP_OWNER_ID`.
- `get_projects`: choose the project you want this server to default to and copy its `id` to `TP_PROJECT_ID`.
- `get_teams`: choose the team you want as the default and copy its `id` to `TP_TEAM_ID`.
- `get_processes`: choose the process used by that project and copy its `id` to `TP_PROCESS_ID`.

`TP_USER_STORY_WORKFLOW_ID` and `TP_BUG_WORKFLOW_ID` are loaded by config for compatibility, but the current code does not use them. Leave them unset unless a future tool starts requiring them.

## Running With Nix

The flake default app is jailed with jail.nix/bubblewrap:

```bash
TP_BASE_URL=https://your-instance.tpondemand.com \
TP_TOKEN=... \
nix run path:/path/to/targetprocess-mcp-server
```

The default jailed runtime forwards `TP_BASE_URL` and `TP_TOKEN` as required values, forwards other `TP_*` values if set, and isolates the Node process with bubblewrap. Node has no direct network access; outbound HTTPS is routed through a host-side tinyproxy allowlist proxy that only permits the exact host from `TP_BASE_URL` on port 443. The jailed process only sees the proxy Unix socket directory, mounted read-only.

For the jailed runtime, `TP_BASE_URL` must be a simple HTTPS URL with no credentials, query string, fragment, explicit port, whitespace, or unsupported hostname characters.

## Troubleshooting

### `MCP startup failed: handshaking with MCP server failed`

This means the MCP process exited before it could answer Codex's initialize
request. Common causes:

- `TP_BASE_URL` is missing or not an HTTPS URL.
- `TP_TOKEN` is missing because the secret command failed.
- `gopass` or another password manager cannot decrypt from Codex's
  non-interactive startup environment.
- Nix cannot build or run the flake from the configured path.

Run the configured command directly in a terminal and check stderr:

```bash
set -e
token="$(gopass Web/targetprocess-token)"
TP_BASE_URL=https://your-instance.tpondemand.com \
TP_TOKEN="$token" \
nix run path:/path/to/targetprocess-mcp-server
```

Expected startup output is `Targetprocess MCP Server running on stdio`. If the
command prints `TP_TOKEN is required`, the secret command returned an empty value
or failed before exporting the token.

### `get_version` Works But Targetprocess Tools Fail

`get_version` only reads local package metadata. It does not prove that
Targetprocess authentication, TLS verification, or proxy egress is working.

Use `get_logged_in_user` or `get_projects` as the first real API smoke test. On
failure, `get_projects` includes a redacted diagnostic with the HTTP status,
request URL, and a bounded response body where available. A `401` response means
Targetprocess rejected the token. TLS errors usually point to the jailed CA
bundle or proxy path. Connection errors usually point to tinyproxy, the Unix
socket bridge, or host network reachability.
