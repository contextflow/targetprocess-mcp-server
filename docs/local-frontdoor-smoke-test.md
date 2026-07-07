# Local Frontdoor Smoke Test

This runs the hosted MCP OAuth callback flow locally without a Google SSO client secret. A tiny local OIDC provider signs a mock `id_token`; the MCP service still uses the real Targetprocess and Frontdoor API-key endpoint:

- `TP_BASE_URL=https://example.tpondemand.com`
- `FRONTDOOR_URL=https://frontdoor-eu.apptio.com`

## Run Locally

Terminal 1:

```sh
npm run start:local-oidc
```

Terminal 2:

```sh
npm run build
set -a
. examples/targetprocess-frontdoor.local.env
set +a
npm run start:http
```

Open the account setup page:

```text
http://localhost:3000/account/targetprocess
```

The browser should redirect through the local OIDC provider, return to `/oauth/callback`, and land on the Targetprocess credential page as `local.user@example.com`.

Enter a real Frontdoor API key access/secret pair. The save action validates the key by calling:

```text
https://frontdoor-eu.apptio.com/service/apikeylogin
```

and then validates Targetprocess access against:

```text
https://example.tpondemand.com/api/v1/Context
```

Without real Frontdoor API key credentials, you can still validate the hosted OAuth routes and callback wiring, but credential save will fail with `frontdoor_credentials_invalid` or `targetprocess_credentials_invalid`.

## MCP OAuth Smoke URL

To exercise the OAuth authorize callback path without Claude, use this URL. It intentionally redirects to a local placeholder callback after the MCP service issues an authorization code.

```text
http://localhost:3000/oauth/authorize?response_type=code&client_id=local-claude-org&redirect_uri=http%3A%2F%2Flocalhost%3A3333%2Fcallback&scope=mcp%3Atools&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=local-smoke
```

Expected final URL shape:

```text
http://localhost:3333/callback?code=<mcp-authorization-code>&state=local-smoke
```

## Production Swap For Claude

For production, prefer Frontdoor as the upstream login provider so users do not create API keys. Keep the Targetprocess and Frontdoor API-host values, but replace the local-only pieces:

```sh
TP_BASE_URL=https://example.tpondemand.com
FRONTDOOR_URL=https://frontdoor-eu.apptio.com
MCP_AUTH_PROVIDER=frontdoor
MCP_PUBLIC_URL=https://<your-public-mcp-host>
MCP_REQUIRE_HTTPS=1
MCP_SIGNING_KEY_B64=<32 random bytes, base64>
TP_TOKEN_ENCRYPTION_KEY_B64=<32 random bytes, base64>
MCP_OAUTH_CLIENTS_JSON='[{"client_id":"claude-org","name":"Claude org connector","redirect_uris":["<exact Claude org connector callback URL>"],"allowed_origins":["https://claude.ai"],"scopes":["mcp:tools"]}]'
```

Generate production keys with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
