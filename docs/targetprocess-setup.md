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
