#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { config as appConfig } from "./config.js"
import { createTargetprocessMcpServer } from "./index.js"
import { TpClient, type TargetprocessAuth } from "./tp.js"
import { loadHostedConfig, metadataPathForResource, type HostedConfig } from "./hosted/config.js"
import { OAuthBroker, OAuthHttpError, redirectUriAllowed, type AuthenticatedMcpRequest, type OAuthAuthorizationResume } from "./hosted/oauth.js"
import { decideToolAccess, defaultAccessPolicy, normalizePolicy, sharedTokenPolicy, type AccessMode, type PolicyCategory, type TargetprocessAccessPolicy } from "./hosted/policy.js"
import { EncryptedFileCredentialStore, type TargetprocessAccount, type TargetprocessCredential, type TargetprocessCredentialStore } from "./hosted/token_store.js"
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
  sessions: Map<string, SessionRecord>
  oauthResumes?: Map<string, OAuthResumeRecord>
  oauthResumesLoaded?: boolean
  rateLimits?: Map<string, RateLimitRecord>
  allowEmptyUnauthenticatedMcpProbeUntil?: number
}

const accountCookieName = "__Host-tpmcp_account"

type OAuthResumeRecord = OAuthAuthorizationResume & {
  expiresAt: number
}

type OAuthResumeStoreFile = {
  version: 1
  resumes: Record<string, OAuthResumeRecord>
}

type RateLimitRecord = {
  windowStart: number
  count: number
}

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

  if (url.pathname === metadataPathForResource(runtime.config.resource) || url.pathname === "/.well-known/oauth-protected-resource") {
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
      const account = await resolveUsableAccount(runtime, result.user.id, result.user.email)
      if (!account) return redirectToCredentialSetup(runtime, res, result)
      try {
        await validateAccount(runtime, account)
      } catch (error) {
        if (!(error instanceof OAuthHttpError) || error.code !== "targetprocess_credentials_invalid") throw error
        await runtime.credentialStore.deleteCredential(result.user.id)
        redirectToCredentialSetup(runtime, res, result, "invalid")
        return
      }
      redirectToCredentialSetup(runtime, res, result)
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
    const tokenResponse = runtime.oauth.exchangeToken(form, req.headers.authorization)
    runtime.allowEmptyUnauthenticatedMcpProbeUntil = Date.now() + 30_000
    sendJson(res, 200, tokenResponse)
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
  const url = requestUrl(runtime.config, req)
  let resume = validResumeRedirect(runtime.config, url.searchParams.get("resume"))
  let oauthResume = validOAuthResumeId(runtime, url.searchParams.get("oauth_resume"))
  const sessionToken = getCookie(req, accountCookieName)
  if (!sessionToken) {
    if (req.method !== "GET") return methodNotAllowed(res)
    redirect(res, runtime.oauth.buildAccountLoginRedirect())
    return
  }

  const account = runtime.oauth.verifyAccountSession(sessionToken)
  if (req.method === "GET") {
    const storedAccount = await getDisplayAccount(runtime, account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: storedAccount,
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      csrf: account.csrf,
      message: url.searchParams.get("finish") === "review"
        ? "Review your Targetprocess MCP configuration, then finish the MCP login."
        : url.searchParams.get("credential") === "invalid"
        ? "Your saved Targetprocess token is invalid or expired. Paste a current personal access token to continue."
        : "",
      messageKind: url.searchParams.get("credential") === "invalid" ? "error" : "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
    }))
    return
  }

  if (req.method !== "POST") return methodNotAllowed(res)

  const contentType = req.headers["content-type"] || ""
  const body = contentType.includes("application/json")
    ? await readJson<AccountPostBody>(req)
    : Object.fromEntries((await readForm(req)).entries()) as AccountPostBody
  resume = resume || validResumeRedirect(runtime.config, body.resume || null)
  oauthResume = oauthResume || validOAuthResumeId(runtime, body.oauth_resume || null)

  if (body.csrf !== account.csrf) throw new OAuthHttpError(403, "invalid_csrf")

  if (body.action === "revoke") {
    await runtime.credentialStore.deleteCredential(account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      csrf: account.csrf,
      message: "Targetprocess credential revoked.",
      messageKind: "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
    }))
    return
  }

  if (body.action === "finish_oauth") {
    const record = oauthResume ? takeOAuthResume(runtime, oauthResume, account.user.id) : null
    if (!record) throw new OAuthHttpError(400, "invalid_oauth_resume")
    const storedAccount = await resolveUsableAccount(runtime, account.user.id, account.user.email)
    if (!storedAccount) return redirectToCredentialSetup(runtime, res, record)
    await validateAccount(runtime, storedAccount)
    redirect(res, runtime.oauth.buildClientAuthorizationRedirect(record))
    return
  }

  if (body.action === "settings" || body.action === "shared") {
    const settings = accountSettingsFromBody(body)
    if (settings.accessMode === "shared") {
      await validateSharedToken(runtime)
      await runtime.credentialStore.setAccount(account.user.id, account.user.email, {
        credential: { kind: "targetprocess_shared_token" },
        accessMode: "shared",
        policy: settings.policy,
      })
    } else {
      const existingAccount = await runtime.credentialStore.getAccount(account.user.id)
      if (existingAccount?.credential?.kind !== "targetprocess_access_token") {
        sendHtml(res, 400, accountPage({
          email: account.user.email,
          account: await getDisplayAccount(runtime, account.user.id),
          sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
          csrf: account.csrf,
          message: "Paste and save a personal Targetprocess token before switching to personal-token mode.",
          messageKind: "error",
          personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
          resume,
          oauthResume,
        }))
        return
      }
      await runtime.credentialStore.setSettings(account.user.id, account.user.email, settings)
    }
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      csrf: account.csrf,
      message: "Targetprocess MCP settings saved.",
      messageKind: "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
    }))
    return
  }

  const credential = accountCredentialFromBody(body)
  const settings = accountSettingsFromBody(body)
  try {
    await validateTargetprocessCredential(runtime, credential)
  } catch (error) {
    if (!(error instanceof OAuthHttpError) || error.code !== "targetprocess_credentials_invalid") throw error
    sendHtml(res, 400, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      csrf: account.csrf,
      message: "Targetprocess rejected that token. Create or copy a personal access token and try again.",
      messageKind: "error",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
    }))
    return
  }
  await runtime.credentialStore.setAccount(account.user.id, account.user.email, {
    credential,
    accessMode: "personal",
    policy: settings.policy,
  })
  sendHtml(res, 200, accountPage({
    email: account.user.email,
    account: await getDisplayAccount(runtime, account.user.id),
    sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
    csrf: account.csrf,
    message: oauthResume ? "Targetprocess credential saved. Review your configuration, then finish the MCP login." : "Targetprocess credential saved.",
    messageKind: "info",
    personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
    resume,
    oauthResume,
  }))
}

async function handleMcp(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  validateHttpBoundary(runtime.config, req)
  if (!req.headers.authorization && isEmptyPost(req) && (runtime.allowEmptyUnauthenticatedMcpProbeUntil || 0) > Date.now()) {
    sendText(res, 202, "")
    return
  }
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
  const account = await getDisplayAccount(runtime, auth.userId)

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
    const server = createTargetprocessMcpServer(tp, {
      accessMode: account.accessMode,
      policy: account.accessMode === "shared" ? sharedTokenPolicy : account.policy,
      userEmail: auth.email,
      checkToolCall: async (toolName, category) => {
        const freshAccount = await getDisplayAccount(runtime, auth.userId)
        const policy = freshAccount.accessMode === "shared" ? sharedTokenPolicy : freshAccount.policy
        const decision = decideToolAccess(freshAccount.accessMode, policy, toolName)
        if (!decision.allowed) return decision.reason
        return checkRateLimit(runtime, auth.userId, category, policy)
      },
      prepareToolArgs: async (toolName, args) => {
        const freshAccount = await getDisplayAccount(runtime, auth.userId)
        if (freshAccount.accessMode !== "shared" || toolName !== "add_comment") return args
        return {
          ...args,
          comment: `MCP authenticated user: ${auth.email}\n\n${args.comment || ""}`,
        }
      },
    })
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

function isEmptyPost(req: IncomingMessage): boolean {
  return req.method === "POST" && headerValue(req.headers["content-length"]) === "0"
}

function validateOrigin(config: HostedConfig, auth: AuthenticatedMcpRequest, req: IncomingMessage): void {
  const origin = headerValue(req.headers.origin)
  if (!origin) return
  const client = config.oauthClients.get(auth.clientId)
  const publicOrigin = new URL(config.publicUrl).origin
  const allowed = new Set([publicOrigin, ...config.allowedOrigins, ...(client?.allowedOrigins || [])])
  if (!allowed.has(origin)) throw new OAuthHttpError(403, "invalid_origin")
}

function checkRateLimit(
  runtime: Runtime,
  userId: string,
  category: PolicyCategory,
  policy: TargetprocessAccessPolicy,
): string | null {
  if (category !== "create" && category !== "comment") return null
  const limit = category === "create"
    ? policy.createLimitPerHour
    : policy.commentLimitPerHour
  if (limit <= 0) return `Rate limit exceeded for ${category} tools: 0 per hour.`

  const key = `${userId}:${category}`
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  runtime.rateLimits ||= new Map()
  const current = runtime.rateLimits.get(key)
  const record = !current || current.windowStart + windowMs <= now
    ? { windowStart: now, count: 0 }
    : current
  if (record.count >= limit) {
    return `Rate limit exceeded for ${category} tools: ${limit} per hour.`
  }
  record.count += 1
  runtime.rateLimits.set(key, record)
  return null
}

function validResumeRedirect(config: HostedConfig, rawResume: string | null): string {
  if (!rawResume) return ""
  let resumeUrl: URL
  try {
    resumeUrl = new URL(rawResume)
  } catch {
    return ""
  }
  for (const client of config.oauthClients.values()) {
    if (redirectUriAllowed(client, resumeUrl.toString())) return resumeUrl.toString()
  }
  return ""
}

type AccountPostBody = {
  csrf?: string
  token?: string
  resume?: string
  credential_kind?: string
  credentialKind?: string
  action?: "revoke" | "settings" | "shared" | "token" | "finish_oauth"
  oauth_resume?: string
  access_mode?: string
  allow_deletes?: string
  allow_relation_deletes?: string
  allow_creates?: string
  create_limit_per_hour?: string
  allow_comments?: string
  comment_limit_per_hour?: string
  allow_updates?: string
  allow_attachments?: string
  allow_labels?: string
  allow_relations?: string
  allow_test_writes?: string
  allow_time_logging?: string
}

function accountCredentialFromBody(body: AccountPostBody): TargetprocessCredential {
  const kind = body.credentialKind || body.credential_kind || "targetprocess_access_token"
  if (kind === "targetprocess_access_token") {
    const token = body.token?.trim()
    if (!token) throw new OAuthHttpError(400, "targetprocess_token_required")
    return { kind, token }
  }
  throw new OAuthHttpError(400, "unsupported_targetprocess_credential")
}

async function resolveTargetprocessAuth(runtime: Runtime, userId: string): Promise<TargetprocessAuth | null> {
  const account = await runtime.credentialStore.getAccount(userId)
  if (!account?.credential) return null
  if (account.accessMode === "shared" || account.credential.kind === "targetprocess_shared_token") {
    if (!runtime.config.tpSharedToken) return null
    return { kind: "accessToken", token: runtime.config.tpSharedToken }
  }
  return { kind: "accessToken", token: account.credential.token }
}

async function validateTargetprocessCredential(runtime: Runtime, credential: TargetprocessCredential): Promise<void> {
  if (credential.kind === "targetprocess_shared_token") return validateSharedToken(runtime)
  const tp = new TpClient({
    baseUrl: runtime.config.tpBaseUrl,
    auth: { kind: "accessToken", token: credential.token },
    proxySocket: appConfig.tp.proxySocket,
  })
  const context = await tp.getContext<{ LoggedUser?: { Id?: number | string } }>()
  if (!context?.LoggedUser?.Id) {
    throw new OAuthHttpError(400, "targetprocess_credentials_invalid")
  }
}

async function validateSharedToken(runtime: Runtime): Promise<void> {
  if (!runtime.config.tpSharedToken) throw new OAuthHttpError(400, "targetprocess_credentials_invalid")
  await validateTargetprocessCredential(runtime, { kind: "targetprocess_access_token", token: runtime.config.tpSharedToken })
}

async function validateAccount(runtime: Runtime, account: TargetprocessAccount): Promise<void> {
  if (!account.credential) throw new OAuthHttpError(400, "targetprocess_credentials_invalid")
  await validateTargetprocessCredential(runtime, account.credential)
}

async function resolveUsableAccount(runtime: Runtime, userId: string, email: string): Promise<TargetprocessAccount | null> {
  const account = await runtime.credentialStore.getAccount(userId)
  if (account?.credential) return account
  if (!runtime.config.tpSharedToken) return null

  await validateSharedToken(runtime)
  const sharedAccount: TargetprocessAccount = {
    credential: { kind: "targetprocess_shared_token" },
    accessMode: "shared",
    policy: sharedTokenPolicy,
  }
  await runtime.credentialStore.setAccount(userId, email, sharedAccount)
  return sharedAccount
}

async function getDisplayAccount(runtime: Runtime, userId: string): Promise<TargetprocessAccount> {
  return await runtime.credentialStore.getAccount(userId) || {
    credential: null,
    accessMode: runtime.config.tpSharedToken ? "shared" : "personal",
    policy: runtime.config.tpSharedToken ? sharedTokenPolicy : defaultAccessPolicy,
  }
}

function accountSettingsFromBody(body: AccountPostBody): { accessMode: AccessMode; policy: TargetprocessAccessPolicy } {
  const accessMode: AccessMode = body.access_mode === "shared" ? "shared" : "personal"
  const policy = accessMode === "shared"
    ? sharedTokenPolicy
    : normalizePolicy({
        allowDeletes: checked(body.allow_deletes),
        allowRelationDeletes: checked(body.allow_relation_deletes),
        allowCreates: checked(body.allow_creates),
        createLimitPerHour: parseLimit(body.create_limit_per_hour, defaultAccessPolicy.createLimitPerHour),
        allowComments: checked(body.allow_comments),
        commentLimitPerHour: parseLimit(body.comment_limit_per_hour, defaultAccessPolicy.commentLimitPerHour),
        allowUpdates: checked(body.allow_updates),
        allowAttachments: checked(body.allow_attachments),
        allowLabels: checked(body.allow_labels),
        allowRelations: checked(body.allow_relations),
        allowTestWrites: checked(body.allow_test_writes),
        allowTimeLogging: checked(body.allow_time_logging),
      })
  return { accessMode, policy }
}

function checked(value: string | undefined): boolean {
  return value === "on" || value === "true" || value === "1"
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback
}

function redirectToCredentialSetup(
  runtime: Runtime,
  res: ServerResponse,
  result: OAuthAuthorizationResume,
  credentialState?: "invalid",
): void {
  const setupUrl = new URL("/account/targetprocess", runtime.config.publicUrl)
  setupUrl.searchParams.set("oauth_resume", createOAuthResume(runtime, result))
  setupUrl.searchParams.set("finish", "review")
  if (credentialState) setupUrl.searchParams.set("credential", credentialState)
  redirect(res, setupUrl.toString(), {
    "Set-Cookie": setCookie(accountCookieName, runtime.oauth.createAccountSession(result.user), 60 * 60 * 8),
  })
}

function createOAuthResume(runtime: Runtime, result: OAuthAuthorizationResume): string {
  cleanupOAuthResumes(runtime)
  const id = randomUUID()
  oauthResumeStore(runtime).set(id, {
    ...result,
    expiresAt: Date.now() + 30 * 60 * 1000,
  })
  persistOAuthResumes(runtime)
  return id
}

function validOAuthResumeId(runtime: Runtime, rawId: string | null | undefined): string {
  if (!rawId) return ""
  cleanupOAuthResumes(runtime)
  return oauthResumeStore(runtime).has(rawId) ? rawId : ""
}

function takeOAuthResume(runtime: Runtime, id: string, userId: string): OAuthAuthorizationResume | null {
  cleanupOAuthResumes(runtime)
  const store = oauthResumeStore(runtime)
  const record = store.get(id)
  store.delete(id)
  persistOAuthResumes(runtime)
  if (!record || record.user.id !== userId) return null
  const { expiresAt: _expiresAt, ...resume } = record
  return resume
}

function cleanupOAuthResumes(runtime: Runtime): void {
  const now = Date.now()
  let changed = false
  for (const [id, record] of oauthResumeStore(runtime)) {
    if (record.expiresAt <= now) {
      oauthResumeStore(runtime).delete(id)
      changed = true
    }
  }
  if (changed) persistOAuthResumes(runtime)
}

function oauthResumeStore(runtime: Runtime): Map<string, OAuthResumeRecord> {
  if (!runtime.oauthResumesLoaded) {
    runtime.oauthResumes = loadOAuthResumes(runtime)
    runtime.oauthResumesLoaded = true
  }
  runtime.oauthResumes ||= new Map()
  return runtime.oauthResumes
}

function loadOAuthResumes(runtime: Runtime): Map<string, OAuthResumeRecord> {
  const store = new Map<string, OAuthResumeRecord>()
  const path = oauthResumeStorePath(runtime)
  if (!path) return store
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OAuthResumeStoreFile
    if (parsed.version !== 1) return store
    for (const [id, record] of Object.entries(parsed.resumes || {})) {
      store.set(id, record)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return store
}

function persistOAuthResumes(runtime: Runtime): void {
  const path = oauthResumeStorePath(runtime)
  if (!path) return
  const state: OAuthResumeStoreFile = {
    version: 1,
    resumes: Object.fromEntries(oauthResumeStore(runtime)),
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tempPath, path)
}

function oauthResumeStorePath(runtime: Runtime): string {
  return runtime.config.oauthStateStorePath ? `${runtime.config.oauthStateStorePath}.account-resumes.json` : ""
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

function accountPage({
  email,
  account,
  sharedTokenAvailable,
  csrf,
  message,
  messageKind,
  personalAccessTokensUrl,
  resume,
  oauthResume,
}: {
  email: string
  account: TargetprocessAccount
  sharedTokenAvailable: boolean
  csrf: string
  message: string
  messageKind: "info" | "error"
  personalAccessTokensUrl: string
  resume: string
  oauthResume: string
}): string {
  const policy = account.accessMode === "shared" ? sharedTokenPolicy : normalizePolicy(account.policy)
  const hiddenResume = hiddenResumeFields(resume, oauthResume)
  const hasPersonalToken = account.credential?.kind === "targetprocess_access_token"
  const isShared = account.accessMode === "shared"
  const canFinish = Boolean(oauthResume && (account.credential || (isShared && sharedTokenAvailable)))
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Targetprocess MCP</title>
  <style>
    body { font: 16px/1.4 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; color: #17202a; }
    label, input, button, select { box-sizing: border-box; }
    label { display: block; margin: .6rem 0 .25rem; font-weight: 600; }
    input[type="password"], input[type="number"], select { width: 100%; margin: .2rem 0 1rem; padding: .65rem; }
    .check label { display: flex; gap: .5rem; align-items: center; font-weight: 400; margin: .45rem 0; }
    button { width: auto; padding: .55rem .8rem; }
    .status { margin: 1rem 0; padding: .75rem; background: #eef6ee; }
    .error { margin: 1rem 0; padding: .75rem; background: #fdecec; }
    fieldset { margin: 1.25rem 0; padding: 1rem; border: 1px solid #ccd3da; }
    legend { font-weight: 700; }
    .muted { color: #5b6773; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
    .danger { margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Targetprocess MCP</h1>
  <p>Signed in as ${escapeHtml(email)}.</p>
  ${message ? `<p class="${messageKind === "error" ? "error" : "status"}">${escapeHtml(message)}</p>` : ""}
  <p>Access mode: <strong>${isShared ? "service token" : "personal Targetprocess token"}</strong>.</p>
  <p>Personal token status: <strong>${hasPersonalToken ? "saved" : "not saved"}</strong>.</p>

  <form method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    ${hiddenResume}
    <fieldset>
      <legend>Credential</legend>
      <label for="access_mode">Token mode</label>
      <select id="access_mode" name="access_mode">
        <option value="shared"${isShared ? " selected" : ""}${sharedTokenAvailable ? "" : " disabled"}>Use service token for read and attributed comments</option>
        <option value="personal"${!isShared ? " selected" : ""}>Use my personal Targetprocess token</option>
      </select>
      ${sharedTokenAvailable ? "" : `<p class="muted">Service token mode is not configured on this server.</p>`}
      <p class="muted">
        Open <a href="${escapeHtml(personalAccessTokensUrl)}" target="_blank" rel="noopener noreferrer">Targetprocess personal access tokens</a>
        in a new tab to create or copy a personal token.
      </p>
      <label for="token">Replace personal Targetprocess token</label>
      <input id="token" name="token" type="password" autocomplete="off">
    </fieldset>
    ${policyFields(policy)}
    <div class="actions">
      <button type="submit" name="action" value="settings">Save configuration</button>
      <button type="submit" name="action" value="token">Save personal token and configuration</button>
    </div>
  </form>
  ${canFinish ? `
  <form method="post" class="status">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="action" value="finish_oauth">
    ${hiddenResume}
    <button type="submit">Finish MCP login</button>
  </form>` : ""}
  ${hasPersonalToken ? `
  <form class="danger" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="action" value="revoke">
    ${hiddenResume}
    <button type="submit">Revoke personal token</button>
  </form>` : ""}
</body>
</html>`
}

function hiddenResumeFields(resume: string, oauthResume: string): string {
  return [
    resume ? `<input type="hidden" name="resume" value="${escapeHtml(resume)}">` : "",
    oauthResume ? `<input type="hidden" name="oauth_resume" value="${escapeHtml(oauthResume)}">` : "",
  ].join("")
}

function policyFields(policy: TargetprocessAccessPolicy): string {
  return `<fieldset>
    <legend>Safety limits</legend>
    <div class="check">
      ${checkbox("allow_deletes", "Allow ticket deletion", policy.allowDeletes)}
      ${checkbox("allow_relation_deletes", "Allow relation deletion", policy.allowRelationDeletes)}
      ${checkbox("allow_creates", "Allow create tools", policy.allowCreates)}
    </div>
    <label for="create_limit_per_hour">Create calls per hour</label>
    <input id="create_limit_per_hour" name="create_limit_per_hour" type="number" min="0" value="${policy.createLimitPerHour}">
    <div class="check">
      ${checkbox("allow_comments", "Allow comments", policy.allowComments)}
    </div>
    <label for="comment_limit_per_hour">Comment calls per hour</label>
    <input id="comment_limit_per_hour" name="comment_limit_per_hour" type="number" min="0" value="${policy.commentLimitPerHour}">
    <div class="check">
      ${checkbox("allow_updates", "Allow updates and state changes", policy.allowUpdates)}
      ${checkbox("allow_attachments", "Allow file attachments", policy.allowAttachments)}
      ${checkbox("allow_labels", "Allow label/tag changes", policy.allowLabels)}
      ${checkbox("allow_relations", "Allow relation creation", policy.allowRelations)}
      ${checkbox("allow_test_writes", "Allow test writes", policy.allowTestWrites)}
      ${checkbox("allow_time_logging", "Allow time logging", policy.allowTimeLogging)}
    </div>
  </fieldset>`
}

function checkbox(name: string, label: string, checkedValue: boolean): string {
  return `<label><input type="checkbox" name="${escapeHtml(name)}"${checkedValue ? " checked" : ""}> ${escapeHtml(label)}</label>`
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
  const runtime: Runtime = {
    config,
    oauth: new OAuthBroker(config),
    credentialStore: new EncryptedFileCredentialStore(config.tokenStorePath, config.tokenEncryptionKey),
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
