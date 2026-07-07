#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { config as appConfig } from "./config.js"
import { createTargetprocessMcpServer } from "./index.js"
import { TpClient, type TargetprocessAuth } from "./tp.js"
import { loadHostedConfig, metadataPathForResource, type HostedConfig } from "./hosted/config.js"
import { FrontdoorAuthError, FrontdoorClient, FrontdoorOpenTokenCache } from "./hosted/frontdoor.js"
import { OAuthBroker, OAuthHttpError, type AuthenticatedMcpRequest } from "./hosted/oauth.js"
import { EncryptedFileCredentialStore, type TargetprocessCredential, type TargetprocessCredentialStore } from "./hosted/token_store.js"
import {
  getCookie,
  methodNotAllowed,
  readForm,
  readJson,
  redirect,
  sendHtml,
  sendJson,
  sendText,
  setCookie,
} from "./hosted/http_utils.js"

type SessionRecord = {
  transport: StreamableHTTPServerTransport
  userId: string
  clientId: string
}

type Runtime = {
  config: HostedConfig
  oauth: OAuthBroker
  credentialStore: TargetprocessCredentialStore
  frontdoorClient?: FrontdoorClient
  frontdoorTokens?: FrontdoorOpenTokenCache
  sessions: Map<string, SessionRecord>
}

const accountCookieName = "__Host-tpmcp_account"

export async function createHostedServer(runtime: Runtime) {
  return createServer(async (req, res) => {
    try {
      await route(runtime, req, res)
    } catch (error) {
      handleHttpError(runtime, res, error)
    }
  })
}

async function route(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = requestUrl(runtime.config, req)
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === metadataPathForResource(runtime.config.resource)) {
    sendJson(res, 200, runtime.oauth.protectedResourceMetadata())
    return
  }

  if (url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, runtime.oauth.authorizationServerMetadata())
    return
  }

  if (url.pathname === "/oauth/authorize") {
    if (req.method !== "GET") return methodNotAllowed(res)
    redirect(res, runtime.oauth.buildAuthorizationRedirect(url))
    return
  }

  if (url.pathname === "/oauth/callback") {
    if (req.method !== "GET") return methodNotAllowed(res)
    const result = await runtime.oauth.completeOidcCallback(url)
    if (result.kind === "oauth") {
      redirect(res, result.redirectUri)
    } else {
      redirect(res, new URL("/account/targetprocess", runtime.config.publicUrl).toString(), {
        "Set-Cookie": setCookie(accountCookieName, result.sessionToken, 60 * 60 * 8),
      })
    }
    return
  }

  if (url.pathname === "/frontdoor/callback") {
    if (req.method !== "GET") return methodNotAllowed(res)
    const code = url.searchParams.get("code") || ""
    if (!code) throw new OAuthHttpError(400, "invalid_frontdoor_callback")
    if (!runtime.frontdoorClient) throw new OAuthHttpError(400, "frontdoor_not_configured")
    const openToken = await runtime.frontdoorClient.exchangeCode(code)
    const user = await frontdoorUserFromOpenToken(runtime, openToken.token)
    await runtime.credentialStore.setCredential(user.id, user.email, {
      kind: "frontdoor_open_token",
      token: openToken.token,
      expiresAt: openToken.expiresAt,
      renewAfter: openToken.renewAfter,
      renewUntil: openToken.renewUntil,
    })
    const result = runtime.oauth.completeFrontdoorCallback(url, user)
    if (result.kind === "oauth") {
      redirect(res, result.redirectUri)
    } else {
      redirect(res, new URL("/account/targetprocess", runtime.config.publicUrl).toString(), {
        "Set-Cookie": setCookie(accountCookieName, result.sessionToken, 60 * 60 * 8),
      })
    }
    return
  }

  if (url.pathname === "/oauth/token") {
    if (req.method !== "POST") return methodNotAllowed(res)
    const form = await readForm(req)
    sendJson(res, 200, runtime.oauth.exchangeToken(form, req.headers.authorization))
    return
  }

  if (url.pathname === "/account/targetprocess") {
    await handleAccount(runtime, req, res)
    return
  }

  if (url.pathname === runtime.config.mcpPath) {
    await handleMcp(runtime, req, res)
    return
  }

  sendText(res, 404, "Not found")
}

async function handleAccount(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionToken = getCookie(req, accountCookieName)
  if (!sessionToken) {
    if (req.method !== "GET") return methodNotAllowed(res)
    redirect(res, runtime.oauth.buildAccountLoginRedirect())
    return
  }

  const account = runtime.oauth.verifyAccountSession(sessionToken)
  if (req.method === "GET") {
    const credential = await runtime.credentialStore.getCredential(account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      hasCredential: Boolean(credential),
      credentialLabel: credentialLabel(credential),
      csrf: account.csrf,
      message: "",
      frontdoorEnabled: Boolean(runtime.config.frontdoorUrl),
      frontdoorUpstream: runtime.config.authProvider === "frontdoor",
    }))
    return
  }

  if (req.method !== "POST") return methodNotAllowed(res)

  const contentType = req.headers["content-type"] || ""
  const body = contentType.includes("application/json")
    ? await readJson<AccountPostBody>(req)
    : Object.fromEntries((await readForm(req)).entries()) as AccountPostBody

  if (body.csrf !== account.csrf) throw new OAuthHttpError(403, "invalid_csrf")

  if (body.action === "revoke") {
    await runtime.credentialStore.deleteCredential(account.user.id)
    runtime.frontdoorTokens?.delete(account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      hasCredential: false,
      credentialLabel: "none",
      csrf: account.csrf,
      message: "Targetprocess credential revoked.",
      frontdoorEnabled: Boolean(runtime.config.frontdoorUrl),
      frontdoorUpstream: runtime.config.authProvider === "frontdoor",
    }))
    return
  }

  if (body.action === "frontdoor_reconnect") {
    redirect(res, runtime.oauth.buildAccountLoginRedirect())
    return
  }

  const credential = accountCredentialFromBody(runtime.config, body)
  await validateTargetprocessCredential(runtime, account.user.id, credential)
  await runtime.credentialStore.setCredential(account.user.id, account.user.email, credential)
  sendHtml(res, 200, accountPage({
    email: account.user.email,
    hasCredential: true,
    credentialLabel: credentialLabel(credential),
    csrf: account.csrf,
    message: "Targetprocess credential saved.",
    frontdoorEnabled: Boolean(runtime.config.frontdoorUrl),
    frontdoorUpstream: runtime.config.authProvider === "frontdoor",
  }))
}

async function handleMcp(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  validateHttpBoundary(runtime.config, req)
  const auth = runtime.oauth.authenticateBearer(req.headers.authorization)
  validateOrigin(runtime.config, auth, req)

  const sessionId = headerValue(req.headers["mcp-session-id"])

  if (req.method === "DELETE") {
    if (!sessionId) {
      sendText(res, 400, "Mcp-Session-Id is required")
      return
    }
    const record = runtime.sessions.get(sessionId)
    if (!record || record.userId !== auth.userId || record.clientId !== auth.clientId) {
      sendText(res, 404, "Unknown MCP session")
      return
    }
    runtime.sessions.delete(sessionId)
    await record.transport.close()
    sendText(res, 202, "")
    return
  }

  if (req.method !== "POST" && req.method !== "GET") return methodNotAllowed(res)

  const tpAuth = await resolveTargetprocessAuth(runtime, auth.userId)
  if (!tpAuth) throw new OAuthHttpError(403, "targetprocess_credentials_required")

  let transport: StreamableHTTPServerTransport
  if (sessionId) {
    const record = runtime.sessions.get(sessionId)
    if (!record) {
      sendText(res, 404, "Unknown MCP session")
      return
    }
    if (record.userId !== auth.userId || record.clientId !== auth.clientId) {
      sendText(res, 403, "MCP session belongs to another principal")
      return
    }
    transport = record.transport
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    const tp = new TpClient({
      baseUrl: runtime.config.tpBaseUrl,
      auth: tpAuth,
      ownerId: appConfig.tp.ownerId,
      projectId: appConfig.tp.projectId,
      teamId: appConfig.tp.teamId,
      processId: appConfig.tp.processId,
      proxySocket: appConfig.tp.proxySocket,
    })
    const server = createTargetprocessMcpServer(tp)
    await server.connect(transport)
  }

  await transport.handleRequest(req, res)

  if (!sessionId && transport.sessionId) {
    runtime.sessions.set(transport.sessionId, {
      transport,
      userId: auth.userId,
      clientId: auth.clientId,
    })
  }
}

function validateHttpBoundary(config: HostedConfig, req: IncomingMessage): void {
  const expectedHost = new URL(config.publicUrl).host
  if (req.headers.host !== expectedHost) {
    throw new OAuthHttpError(403, "invalid_host")
  }

  const publicProtocol = new URL(config.publicUrl).protocol
  const forwardedProto = headerValue(req.headers["x-forwarded-proto"])
  const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted)
  if (config.requireHttps && publicProtocol === "https:" && !encrypted && forwardedProto !== "https") {
    throw new OAuthHttpError(403, "https_required")
  }
}

function validateOrigin(config: HostedConfig, auth: AuthenticatedMcpRequest, req: IncomingMessage): void {
  const origin = headerValue(req.headers.origin)
  if (!origin) return
  const client = config.oauthClients.get(auth.clientId)
  const publicOrigin = new URL(config.publicUrl).origin
  const allowed = new Set([publicOrigin, ...config.allowedOrigins, ...(client?.allowedOrigins || [])])
  if (!allowed.has(origin)) throw new OAuthHttpError(403, "invalid_origin")
}

type AccountPostBody = {
  csrf?: string
  token?: string
  key_access?: string
  keyAccess?: string
  key_secret?: string
  keySecret?: string
  credential_kind?: string
  credentialKind?: string
  action?: string
}

function accountCredentialFromBody(config: HostedConfig, body: AccountPostBody): TargetprocessCredential {
  const kind = body.credentialKind || body.credential_kind || (config.frontdoorUrl ? "frontdoor_api_key" : "targetprocess_access_token")
  if (kind === "frontdoor_api_key") {
    if (!config.frontdoorUrl) throw new OAuthHttpError(400, "frontdoor_not_configured")
    const keyAccess = (body.keyAccess || body.key_access || "").trim()
    const keySecret = (body.keySecret || body.key_secret || "").trim()
    if (!keyAccess || !keySecret) throw new OAuthHttpError(400, "frontdoor_api_key_required")
    return { kind, keyAccess, keySecret }
  }
  if (kind === "targetprocess_access_token") {
    const token = body.token?.trim()
    if (!token) throw new OAuthHttpError(400, "targetprocess_token_required")
    return { kind, token }
  }
  throw new OAuthHttpError(400, "unsupported_targetprocess_credential")
}

async function resolveTargetprocessAuth(runtime: Runtime, userId: string): Promise<TargetprocessAuth | null> {
  const credential = await runtime.credentialStore.getCredential(userId)
  if (!credential) return null
  return targetprocessAuthForCredential(runtime, userId, credential)
}

async function targetprocessAuthForCredential(runtime: Runtime, userId: string, credential: TargetprocessCredential): Promise<TargetprocessAuth> {
  if (credential.kind === "targetprocess_access_token") {
    return { kind: "accessToken", token: credential.token }
  }
  if (credential.kind === "frontdoor_open_token") {
    return { kind: "apptioOpenToken", token: await resolveFrontdoorOpenToken(runtime, userId, credential) }
  }
  if (!runtime.frontdoorTokens) throw new OAuthHttpError(400, "frontdoor_not_configured")
  try {
    return {
      kind: "apptioOpenToken",
      token: await runtime.frontdoorTokens.getOpenToken(userId, credential),
    }
  } catch (error) {
    if (error instanceof FrontdoorAuthError) throw new OAuthHttpError(403, "frontdoor_credentials_invalid")
    throw error
  }
}

async function resolveFrontdoorOpenToken(runtime: Runtime, userId: string, credential: Extract<TargetprocessCredential, { kind: "frontdoor_open_token" }>): Promise<string> {
  const now = Date.now()
  const renewalDue = credential.expiresAt !== undefined && credential.expiresAt <= now + 60_000
    || credential.renewAfter !== undefined && credential.renewAfter <= now
  if (!renewalDue) return credential.token
  if (!runtime.frontdoorClient) throw new OAuthHttpError(400, "frontdoor_not_configured")

  try {
    const renewed = await runtime.frontdoorClient.renewToken(credential.token)
    await runtime.credentialStore.setCredential(userId, userId, {
      kind: "frontdoor_open_token",
      token: renewed.token,
      expiresAt: renewed.expiresAt,
      renewAfter: renewed.renewAfter,
      renewUntil: renewed.renewUntil,
    })
    return renewed.token
  } catch (error) {
    const expired = credential.expiresAt !== undefined && credential.expiresAt <= now
    if (!expired) return credential.token
    if (error instanceof FrontdoorAuthError) throw new OAuthHttpError(403, "frontdoor_credentials_invalid")
    throw error
  }
}

async function validateTargetprocessCredential(runtime: Runtime, userId: string, credential: TargetprocessCredential): Promise<void> {
  const auth = await targetprocessAuthForCredential(runtime, userId, credential)
  const tp = new TpClient({
    baseUrl: runtime.config.tpBaseUrl,
    auth,
    proxySocket: appConfig.tp.proxySocket,
  })
  const context = await tp.getContext<{ LoggedUser?: { Id?: number | string } }>()
  if (!context?.LoggedUser?.Id) {
    throw new OAuthHttpError(400, "targetprocess_credentials_invalid")
  }
}

async function frontdoorUserFromOpenToken(runtime: Runtime, token: string): Promise<{ id: string; email: string; name?: string; groups: string[] }> {
  const tp = new TpClient({
    baseUrl: runtime.config.tpBaseUrl,
    auth: { kind: "apptioOpenToken", token },
    proxySocket: appConfig.tp.proxySocket,
  })
  const context = await tp.getContext<{
    LoggedUser?: {
      Id?: number | string
      Email?: string
      FirstName?: string
      LastName?: string
      FullName?: string
    }
  }>()
  const loggedUser = context?.LoggedUser
  if (!loggedUser?.Id || !loggedUser.Email) {
    throw new OAuthHttpError(400, "targetprocess_credentials_invalid")
  }
  const name = loggedUser.FullName || [loggedUser.FirstName, loggedUser.LastName].filter(Boolean).join(" ") || undefined
  return {
    id: `tp:${loggedUser.Id}`,
    email: loggedUser.Email.toLowerCase(),
    name,
    groups: [],
  }
}

function requestUrl(config: HostedConfig, req: IncomingMessage): URL {
  return new URL(req.url || "/", config.publicUrl)
}

function handleHttpError(runtime: Runtime, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof OAuthHttpError) {
    const headers: Record<string, string> | undefined = error.status === 401
      ? { "WWW-Authenticate": runtime.oauth.wwwAuthenticateHeader() }
      : undefined
    sendJson(res, error.status, { error: error.code }, headers)
    return
  }
  console.error("Hosted MCP request failed:", error instanceof Error ? error.message : error)
  sendJson(res, 500, { error: "internal_server_error" })
}

function credentialLabel(credential: TargetprocessCredential | null): string {
  if (!credential) return "none"
  if (credential.kind === "frontdoor_api_key") return "Frontdoor API key"
  if (credential.kind === "frontdoor_open_token") return "Frontdoor login"
  return "Targetprocess personal access token"
}

function accountPage({
  email,
  hasCredential,
  credentialLabel,
  csrf,
  message,
  frontdoorEnabled,
  frontdoorUpstream,
}: {
  email: string
  hasCredential: boolean
  credentialLabel: string
  csrf: string
  message: string
  frontdoorEnabled: boolean
  frontdoorUpstream: boolean
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Targetprocess MCP</title>
  <style>
    body { font: 16px/1.4 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; color: #17202a; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    input { margin: .4rem 0 1rem; padding: .65rem; }
    button { width: auto; padding: .55rem .8rem; }
    .status { margin: 1rem 0; padding: .75rem; background: #eef6ee; }
    .danger { margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Targetprocess MCP</h1>
  <p>Signed in as ${escapeHtml(email)}.</p>
  ${message ? `<p class="status">${escapeHtml(message)}</p>` : ""}
  <p>Targetprocess credential status: <strong>${hasCredential ? `saved (${escapeHtml(credentialLabel)})` : "not saved"}</strong>.</p>
  ${frontdoorUpstream ? `
  <form method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="action" value="frontdoor_reconnect">
    <button type="submit">${hasCredential ? "Reconnect Frontdoor" : "Connect Frontdoor"}</button>
  </form>` : ""}
  ${frontdoorEnabled && !frontdoorUpstream ? `
  <form method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="credential_kind" value="frontdoor_api_key">
    <label for="key_access">Frontdoor API key access</label>
    <input id="key_access" name="key_access" type="password" autocomplete="off" required>
    <label for="key_secret">Frontdoor API key secret</label>
    <input id="key_secret" name="key_secret" type="password" autocomplete="off" required>
    <button type="submit">Save Frontdoor API key</button>
  </form>` : ""}
  ${!frontdoorUpstream ? `
  <form method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="credential_kind" value="targetprocess_access_token">
    <label for="token">Targetprocess personal access token</label>
    <input id="token" name="token" type="password" autocomplete="off" required>
    <button type="submit">Save Targetprocess token</button>
  </form>` : ""}
  <form class="danger" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="action" value="revoke">
    <button type="submit">Revoke token</button>
  </form>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function main() {
  const config = await loadHostedConfig()
  const frontdoorClient = config.frontdoorUrl ? new FrontdoorClient(config.frontdoorUrl) : undefined
  const runtime: Runtime = {
    config,
    oauth: new OAuthBroker(config),
    credentialStore: new EncryptedFileCredentialStore(config.tokenStorePath, config.tokenEncryptionKey),
    ...(frontdoorClient ? { frontdoorClient, frontdoorTokens: new FrontdoorOpenTokenCache(frontdoorClient) } : {}),
    sessions: new Map(),
  }
  const server = await createHostedServer(runtime)
  server.listen(config.port, () => {
    console.error(`Targetprocess MCP HTTP server listening on ${config.port}`)
  })
}

if (process.argv[1]?.endsWith("/http.js")) {
  main().catch((error) => {
    console.error("Fatal error in hosted MCP main():", error)
    process.exit(1)
  })
}
