#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { config as appConfig } from "./config.js"
import { createTargetprocessMcpServer } from "./index.js"
import { TpClient, type TargetprocessAuth, type TpRequestDiagnostic } from "./tp.js"
import { loadHostedConfig, metadataPathForResource, type HostedConfig } from "./hosted/config.js"
import { OAuthBroker, OAuthHttpError, redirectUriAllowed, type AuthenticatedMcpRequest, type OAuthAuthorizationResume } from "./hosted/oauth.js"
import { decideToolAccess, defaultAccessPolicy, normalizePolicy, sharedTokenPolicy, type AccessMode, type PolicyCategory, type TargetprocessAccessPolicy } from "./hosted/policy.js"
import { EncryptedFileCredentialStore, type TargetprocessAccount, type TargetprocessCredential, type TargetprocessCredentialStore } from "./hosted/token_store.js"
import { MetricsRegistry } from "./hosted/metrics.js"
import { stdoutAuditLogger, targetIdFromArgs, type AuditLogger } from "./hosted/audit.js"
import {
  clearCookie,
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
  consumedOAuthResumes?: Map<string, OAuthResumeRecord>
  oauthResumesLoaded?: boolean
  rateLimits?: Map<string, RateLimitRecord>
  allowEmptyUnauthenticatedMcpProbeUntil?: number
  metrics?: MetricsRegistry
  auditLog?: AuditLogger
}

const accountCookieName = "__Host-tpmcp_account"
const consumedOAuthResumeRetryMs = 2 * 60 * 1000

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

type RequestAuditInfo = {
  requestId: string
  route: string
  clientIp: string
  userId?: string
  userEmail?: string
  clientId?: string
  grantType?: string
  reason?: string
  failureStage?: FailureStage
  errorClass?: string
  errorMessage?: string
  targetprocessDiagnostic?: TpRequestDiagnostic
  securityFailure?: boolean
}

type FailureStage = "auth" | "oauth" | "account" | "mcp_transport" | "policy" | "tool" | "targetprocess_api"

export async function createHostedServer(runtime: Runtime) {
  runtime.metrics ||= new MetricsRegistry()
  runtime.auditLog ||= stdoutAuditLogger
  return createServer(async (req, res) => {
    const audit = createRequestAudit(runtime, req)
    const started = process.hrtime.bigint()
    res.once("finish", () => finishRequestAudit(runtime, req, res, audit, started))
    try {
      await route(runtime, req, res, audit)
    } catch (error) {
      const handled = handleHttpError(runtime, res, error, audit.route)
      audit.reason = handled.reason
      audit.failureStage = handled.failureStage
      audit.errorClass = handled.errorClass
      audit.errorMessage = handled.errorMessage
      audit.targetprocessDiagnostic = handled.targetprocessDiagnostic
      audit.securityFailure = handled.securityFailure
    }
  })
}

async function route(runtime: Runtime, req: IncomingMessage, res: ServerResponse, audit: RequestAuditInfo): Promise<void> {
  const url = requestUrl(runtime.config, req)
  audit.route = normalizedRoute(runtime.config, url)
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === runtime.config.metricsPath) {
    await handleMetrics(runtime, req, res)
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
    audit.userId = result.user.id
    audit.userEmail = result.user.email
    if (result.kind === "oauth") audit.clientId = result.clientId
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
    audit.clientId = tokenRequestClientId(form, req.headers.authorization)
    audit.grantType = reasonCode(form.get("grant_type") || undefined)
    const tokenResponse = runtime.oauth.exchangeToken(form, req.headers.authorization)
    runtime.allowEmptyUnauthenticatedMcpProbeUntil = Date.now() + 30_000
    sendJson(res, 200, tokenResponse)
    return
  }

  if (url.pathname === "/account/targetprocess") {
    await handleAccount(runtime, req, res, audit)
    return
  }

  if (url.pathname === runtime.config.mcpPath) {
    await handleMcp(runtime, req, res, audit)
    return
  }

  sendText(res, 404, "Not found")
}

async function handleMetrics(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return methodNotAllowed(res)
  const expected = runtime.config.metricsBearerToken
  if (!expected) {
    sendText(res, 404, "Not found")
    return
  }
  if (headerValue(req.headers.authorization) !== `Bearer ${expected}`) {
    throw new OAuthHttpError(401, "invalid_metrics_token")
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(runtime.metrics?.render({
    targetprocess_mcp_active_sessions: runtime.sessions.size,
  }) || "")
}

async function handleAccount(runtime: Runtime, req: IncomingMessage, res: ServerResponse, audit: RequestAuditInfo): Promise<void> {
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
  audit.userId = account.user.id
  audit.userEmail = account.user.email
  if (req.method === "GET") {
    const storedAccount = await getDisplayAccount(runtime, account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: storedAccount,
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      clientName: oauthResumeClientName(runtime, oauthResume),
      csrf: account.csrf,
      message: url.searchParams.get("credential") === "invalid"
        ? "Your saved Targetprocess token is invalid or expired. Paste a current personal access token to continue."
        : "",
      messageKind: url.searchParams.get("credential") === "invalid" ? "error" : "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
      tokenInvalid: url.searchParams.get("credential") === "invalid",
    }))
    return
  }

  if (req.method !== "POST") return methodNotAllowed(res)

  const contentType = req.headers["content-type"] || ""
  const body = contentType.includes("application/json")
    ? await readJson<AccountPostBody>(req)
    : Object.fromEntries((await readForm(req)).entries()) as AccountPostBody
  resume = resume || validResumeRedirect(runtime.config, body.resume || null)
  oauthResume = oauthResume || body.oauth_resume || ""

  if (body.csrf !== account.csrf) throw new OAuthHttpError(403, "invalid_csrf")

  if (body.action === "deregister") {
    await runtime.credentialStore.deleteCredential(account.user.id)
    await closeUserSessions(runtime, account.user.id)
    runtime.oauth.revokeUserGrants(account.user.id)
    deleteOAuthResumesForUser(runtime, account.user.id)
    redirect(res, runtime.oauth.buildAccountLoginRedirect({ prompt: "select_account" }), {
      "Set-Cookie": clearCookie(accountCookieName),
    })
    return
  }

  if (body.action === "revoke") {
    await runtime.credentialStore.deleteCredential(account.user.id)
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      clientName: oauthResumeClientName(runtime, oauthResume),
      csrf: account.csrf,
      message: "Targetprocess credential revoked.",
      messageKind: "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
      tokenInvalid: false,
    }))
    return
  }

  if (body.action === "finish_oauth") {
    const record = oauthResume ? lookupOAuthResume(runtime, oauthResume, account.user.id) : null
    if (!record) throw new OAuthHttpError(400, "invalid_oauth_resume")
    const storedAccount = await resolveUsableAccount(runtime, account.user.id, account.user.email)
    if (!storedAccount) return redirectToCredentialSetup(runtime, res, record)
    await validateAccount(runtime, storedAccount)
    const consumed = completeOAuthResume(runtime, oauthResume, account.user.id)
    if (!consumed) throw new OAuthHttpError(400, "invalid_oauth_resume")
    redirect(res, runtime.oauth.buildClientAuthorizationRedirect(consumed))
    return
  }

  if (body.action === "finish_shared_oauth") {
    const record = oauthResume ? lookupOAuthResume(runtime, oauthResume, account.user.id) : null
    if (!record) throw new OAuthHttpError(400, "invalid_oauth_resume")
    await validateSharedToken(runtime)
    await runtime.credentialStore.setAccount(account.user.id, account.user.email, {
      credential: { kind: "targetprocess_shared_token" },
      accessMode: "shared",
      policy: sharedTokenPolicy,
    })
    const consumed = completeOAuthResume(runtime, oauthResume, account.user.id)
    if (!consumed) throw new OAuthHttpError(400, "invalid_oauth_resume")
    redirect(res, runtime.oauth.buildClientAuthorizationRedirect(consumed))
    return
  }

  if (body.action === "save_personal_finish_oauth") {
    const record = oauthResume ? lookupOAuthResume(runtime, oauthResume, account.user.id) : null
    if (!record) throw new OAuthHttpError(400, "invalid_oauth_resume")
    const credential = accountCredentialFromBody(body)
    const settings = personalSettingsFromBody(body, await getDisplayAccount(runtime, account.user.id))
    try {
      await validateTargetprocessCredential(runtime, credential)
    } catch (error) {
      if (!(error instanceof OAuthHttpError) || error.code !== "targetprocess_credentials_invalid") throw error
      markHandledFailure(audit, error, "targetprocess_credentials_invalid", "targetprocess_api")
      sendHtml(res, 400, accountPage({
        email: account.user.email,
        account: await getDisplayAccount(runtime, account.user.id),
        sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
        clientName: oauthResumeClientName(runtime, oauthResume),
        csrf: account.csrf,
        message: "Targetprocess rejected that token. Create or copy a personal access token and try again.",
        messageKind: "error",
        personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
        resume,
        oauthResume,
        tokenInvalid: true,
      }))
      return
    }
    await runtime.credentialStore.setAccount(account.user.id, account.user.email, {
      credential,
      accessMode: "personal",
      policy: settings.policy,
    })
    const consumed = completeOAuthResume(runtime, oauthResume, account.user.id)
    if (!consumed) throw new OAuthHttpError(400, "invalid_oauth_resume")
    redirect(res, runtime.oauth.buildClientAuthorizationRedirect(consumed))
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
          clientName: oauthResumeClientName(runtime, oauthResume),
          csrf: account.csrf,
          message: "Paste and save a personal Targetprocess token before switching to personal-token mode.",
          messageKind: "error",
          personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
          resume,
          oauthResume,
          tokenInvalid: false,
        }))
        return
      }
      await runtime.credentialStore.setSettings(account.user.id, account.user.email, settings)
    }
    sendHtml(res, 200, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      clientName: oauthResumeClientName(runtime, oauthResume),
      csrf: account.csrf,
      message: "Targetprocess MCP settings saved.",
      messageKind: "info",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
      tokenInvalid: false,
    }))
    return
  }

  const credential = accountCredentialFromBody(body)
  const settings = personalSettingsFromBody(body, await getDisplayAccount(runtime, account.user.id))
  try {
    await validateTargetprocessCredential(runtime, credential)
  } catch (error) {
    if (!(error instanceof OAuthHttpError) || error.code !== "targetprocess_credentials_invalid") throw error
    markHandledFailure(audit, error, "targetprocess_credentials_invalid", "targetprocess_api")
    sendHtml(res, 400, accountPage({
      email: account.user.email,
      account: await getDisplayAccount(runtime, account.user.id),
      sharedTokenAvailable: Boolean(runtime.config.tpSharedToken),
      clientName: oauthResumeClientName(runtime, oauthResume),
      csrf: account.csrf,
      message: "Targetprocess rejected that token. Create or copy a personal access token and try again.",
      messageKind: "error",
      personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
      resume,
      oauthResume,
      tokenInvalid: Boolean(oauthResume),
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
    clientName: oauthResumeClientName(runtime, oauthResume),
    csrf: account.csrf,
    message: oauthResume ? "Targetprocess credential saved. Review your configuration, then finish the MCP login." : "Targetprocess credential saved.",
    messageKind: "info",
    personalAccessTokensUrl: runtime.config.tpPersonalAccessTokensUrl,
    resume,
    oauthResume,
    tokenInvalid: false,
  }))
}

async function handleMcp(runtime: Runtime, req: IncomingMessage, res: ServerResponse, audit: RequestAuditInfo): Promise<void> {
  validateHttpBoundary(runtime.config, req)
  if (!req.headers.authorization && isEmptyPost(req) && (runtime.allowEmptyUnauthenticatedMcpProbeUntil || 0) > Date.now()) {
    sendText(res, 202, "")
    return
  }
  const auth = runtime.oauth.authenticateBearer(req.headers.authorization)
  audit.userId = auth.userId
  audit.userEmail = auth.email
  audit.clientId = auth.clientId
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
        if (freshAccount.accessMode !== "shared" || (toolName !== "add_comment" && toolName !== "comment_on_card")) return args
        return {
          ...args,
          comment: `MCP authenticated user: ${auth.email}\n\n${args.comment || ""}`,
        }
      },
      auditToolCall: (event) => {
        runtime.metrics?.increment("targetprocess_mcp_tool_calls_total", "MCP tool calls.", {
          tool: event.toolName,
          category: event.category,
          outcome: event.outcome,
          access_mode: account.accessMode,
        })
        runtime.metrics?.observeDuration("targetprocess_mcp_tool_call_duration_seconds", "MCP tool call duration in seconds.", event.durationMs / 1000, {
          tool: event.toolName,
          category: event.category,
          outcome: event.outcome,
        })
        if (event.outcome === "denied" && event.reason?.startsWith("Rate limit exceeded")) {
          runtime.metrics?.increment("targetprocess_mcp_rate_limit_denials_total", "MCP tool calls denied by rate limits.", {
            category: event.category,
          })
        }
        if (event.outcome !== "success") {
          const targetprocessDiagnostic = event.targetprocessDiagnostic
          recordRequestFailure(runtime, {
            ...audit,
            reason: targetprocessDiagnostic ? targetprocessFailureReason(targetprocessDiagnostic) : toolFailureReason(event.outcome, event.reason),
            failureStage: targetprocessDiagnostic ? "targetprocess_api" : event.outcome === "denied" ? "policy" : "tool",
            targetprocessDiagnostic,
          }, {
            method: req.method,
            route: audit.route || runtime.config.mcpPath,
            status: targetprocessDiagnostic?.status || 200,
            statusClass: targetprocessDiagnostic?.status ? statusClassLabel(targetprocessDiagnostic.status) : "2xx",
            outcome: event.outcome,
            durationMs: event.durationMs,
            toolName: event.toolName,
            category: event.category,
            accessMode: account.accessMode,
            targetId: targetIdFromArgs(event.args),
          })
        }
        runtime.auditLog?.({
          event: "tool_call",
          requestId: audit.requestId,
          clientIp: audit.clientIp,
          userId: auth.userId,
          userEmail: auth.email,
          clientId: auth.clientId,
          accessMode: account.accessMode,
          toolName: event.toolName,
          category: event.category,
          targetId: targetIdFromArgs(event.args),
          outcome: event.outcome,
          reason: reasonCode(event.reason),
          targetprocessMethod: event.targetprocessDiagnostic?.method,
          targetprocessPath: targetprocessPath(event.targetprocessDiagnostic),
          targetprocessStatus: event.targetprocessDiagnostic?.status,
          targetprocessStatusClass: event.targetprocessDiagnostic?.status ? statusClassLabel(event.targetprocessDiagnostic.status) : undefined,
          durationMs: event.durationMs,
        })
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
  action?: "revoke" | "deregister" | "settings" | "shared" | "token" | "finish_oauth" | "finish_shared_oauth" | "save_personal_finish_oauth"
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
    throw withTargetprocessDiagnostic(new OAuthHttpError(400, "targetprocess_credentials_invalid"), tp.getLastRequestDiagnostic())
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

function personalSettingsFromBody(body: AccountPostBody, fallbackAccount: TargetprocessAccount): { accessMode: AccessMode; policy: TargetprocessAccessPolicy } {
  const hasPolicyFields = [
    body.allow_deletes,
    body.allow_relation_deletes,
    body.allow_creates,
    body.create_limit_per_hour,
    body.allow_comments,
    body.comment_limit_per_hour,
    body.allow_updates,
    body.allow_attachments,
    body.allow_labels,
    body.allow_relations,
    body.allow_test_writes,
    body.allow_time_logging,
  ].some((value) => value !== undefined)
  return hasPolicyFields
    ? accountSettingsFromBody({ ...body, access_mode: "personal" })
    : { accessMode: "personal", policy: fallbackAccount.accessMode === "personal" ? normalizePolicy(fallbackAccount.policy) : defaultAccessPolicy }
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

async function closeUserSessions(runtime: Runtime, userId: string): Promise<void> {
  const closes: Promise<void>[] = []
  for (const [sessionId, record] of runtime.sessions) {
    if (record.userId !== userId) continue
    runtime.sessions.delete(sessionId)
    closes.push(record.transport.close().catch(() => undefined))
  }
  await Promise.all(closes)
}

function deleteOAuthResumesForUser(runtime: Runtime, userId: string): void {
  cleanupOAuthResumes(runtime)
  const store = oauthResumeStore(runtime)
  let changed = false
  for (const [id, record] of store) {
    if (record.user.id === userId) {
      store.delete(id)
      changed = true
    }
  }
  if (changed) persistOAuthResumes(runtime)
}

function getOAuthResume(runtime: Runtime, id: string, userId: string): OAuthAuthorizationResume | null {
  cleanupOAuthResumes(runtime)
  const record = oauthResumeStore(runtime).get(id)
  if (!record || record.user.id !== userId) return null
  const { expiresAt: _expiresAt, ...resume } = record
  return resume
}

function lookupOAuthResume(runtime: Runtime, id: string, userId: string): OAuthAuthorizationResume | null {
  return getOAuthResume(runtime, id, userId) || getConsumedOAuthResume(runtime, id, userId)
}

function oauthResumeClientName(runtime: Runtime, id: string): string {
  if (!id) return ""
  const record = oauthResumeStore(runtime).get(id)
  if (!record) return ""
  return runtime.config.oauthClients.get(record.clientId)?.name || record.clientId
}

function completeOAuthResume(runtime: Runtime, id: string, userId: string): OAuthAuthorizationResume | null {
  const consumed = takeOAuthResume(runtime, id, userId)
  if (consumed) {
    consumedOAuthResumeStore(runtime).set(id, {
      ...consumed,
      expiresAt: Date.now() + consumedOAuthResumeRetryMs,
    })
    cleanupConsumedOAuthResumes(runtime)
    return consumed
  }
  return getConsumedOAuthResume(runtime, id, userId)
}

function getConsumedOAuthResume(runtime: Runtime, id: string, userId: string): OAuthAuthorizationResume | null {
  cleanupConsumedOAuthResumes(runtime)
  const record = consumedOAuthResumeStore(runtime).get(id)
  if (!record || record.user.id !== userId) return null
  const { expiresAt: _expiresAt, ...resume } = record
  return resume
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

function consumedOAuthResumeStore(runtime: Runtime): Map<string, OAuthResumeRecord> {
  runtime.consumedOAuthResumes ||= new Map()
  return runtime.consumedOAuthResumes
}

function cleanupConsumedOAuthResumes(runtime: Runtime): void {
  const now = Date.now()
  for (const [id, record] of consumedOAuthResumeStore(runtime)) {
    if (record.expiresAt <= now) consumedOAuthResumeStore(runtime).delete(id)
  }
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

function createRequestAudit(runtime: Runtime, req: IncomingMessage): RequestAuditInfo {
  return {
    requestId: randomUUID(),
    route: "unknown",
    clientIp: clientIp(runtime.config, req),
  }
}

function finishRequestAudit(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  audit: RequestAuditInfo,
  started: bigint,
): void {
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
  const status = res.statusCode || 500
  const outcome = status >= 500 ? "failure" : status >= 400 ? "rejected" : "success"
  const statusClass = statusClassLabel(status)
  const route = audit.route || normalizedRoute(runtime.config, requestUrl(runtime.config, req))
  const reason = audit.reason || statusReason(status)

  runtime.metrics?.increment("targetprocess_mcp_http_requests_total", "Hosted HTTP requests.", {
    method: req.method || "UNKNOWN",
    route,
    status_class: statusClass,
    outcome,
  })
  runtime.metrics?.observeDuration("targetprocess_mcp_http_request_duration_seconds", "Hosted HTTP request duration in seconds.", durationMs / 1000, {
    method: req.method || "UNKNOWN",
    route,
    status_class: statusClass,
  })
  if (status >= 400) {
    runtime.metrics?.increment("targetprocess_mcp_http_failures_total", "Hosted HTTP request failures.", {
      route,
      status_class: statusClass,
      reason,
    })
    recordRequestFailure(runtime, audit, {
      method: req.method,
      route,
      status,
      statusClass,
      outcome,
      durationMs: Math.round(durationMs),
    })
  }
  if (audit.securityFailure) {
    runtime.metrics?.increment("targetprocess_mcp_security_failures_total", "Hosted security failures.", {
      route,
      reason,
    })
    runtime.auditLog?.({
      event: "tp_mcp_security_failure",
      requestId: audit.requestId,
      method: req.method,
      route,
      status,
      outcome: "rejected",
      reason,
      clientIp: audit.clientIp,
      userId: audit.userId,
      userEmail: audit.userEmail,
      clientId: audit.clientId,
      grantType: audit.grantType,
      durationMs: Math.round(durationMs),
    })
  }

  runtime.auditLog?.({
    event: "http_request",
    requestId: audit.requestId,
    method: req.method,
    route,
    status,
    outcome,
    reason: status >= 400 ? reason : undefined,
    clientIp: audit.clientIp,
    userId: audit.userId,
    userEmail: audit.userEmail,
    clientId: audit.clientId,
    grantType: audit.grantType,
    durationMs: Math.round(durationMs),
  })
}

function recordRequestFailure(
  runtime: Runtime,
  audit: RequestAuditInfo,
  event: {
    method?: string
    route: string
    status: number
    statusClass: string
    outcome: string
    durationMs: number
    toolName?: string
    category?: string
    accessMode?: string
    targetId?: string
  },
): void {
  const reason = audit.reason || statusReason(event.status)
  const stage = audit.failureStage || failureStageForHttp(event.route, reason, Boolean(audit.securityFailure), audit.targetprocessDiagnostic)
  const targetprocessDiagnostic = audit.targetprocessDiagnostic
  runtime.metrics?.increment("targetprocess_mcp_request_failures_total", "Hosted MCP request failures by stage and reason.", {
    route: event.route,
    stage,
    status_class: event.statusClass,
    reason,
  })
  runtime.auditLog?.({
    event: "tp_mcp_request_failure",
    requestId: audit.requestId,
    method: event.method,
    route: event.route,
    status: event.status,
    statusClass: event.statusClass,
    outcome: event.outcome,
    reason,
    stage,
    errorClass: audit.errorClass,
    errorMessage: audit.errorMessage,
    clientIp: audit.clientIp,
    userId: audit.userId,
    userEmail: audit.userEmail,
    clientId: audit.clientId,
    grantType: audit.grantType,
    accessMode: event.accessMode,
    toolName: event.toolName,
    category: event.category,
    targetId: event.targetId,
    targetprocessMethod: targetprocessDiagnostic?.method,
    targetprocessPath: targetprocessPath(targetprocessDiagnostic),
    targetprocessStatus: targetprocessDiagnostic?.status,
    targetprocessStatusClass: targetprocessDiagnostic?.status ? statusClassLabel(targetprocessDiagnostic.status) : undefined,
    durationMs: event.durationMs,
  })
}

function handleHttpError(
  runtime: Runtime,
  res: ServerResponse,
  error: unknown,
  route: string,
): {
  reason: string
  securityFailure: boolean
  failureStage?: FailureStage
  errorClass?: string
  errorMessage?: string
  targetprocessDiagnostic?: TpRequestDiagnostic
} {
  if (res.headersSent) {
    res.end()
    return { reason: "headers_sent", securityFailure: false, failureStage: "mcp_transport" }
  }
  if (error instanceof OAuthHttpError) {
    const headers: Record<string, string> | undefined = error.status === 401
      ? { "WWW-Authenticate": runtime.oauth.wwwAuthenticateHeader() }
      : undefined
    sendJson(res, error.status, { error: error.code }, headers)
    const targetprocessDiagnostic = targetprocessDiagnosticFromError(error)
    const securityFailure = isSecurityFailure(error.status, error.code)
    const reason = error.code.startsWith("targetprocess_credentials")
      ? error.code
      : targetprocessDiagnostic ? targetprocessFailureReason(targetprocessDiagnostic) : error.code
    return {
      reason,
      securityFailure,
      failureStage: targetprocessDiagnostic ? "targetprocess_api" : failureStageForHttp(route, error.code, securityFailure),
      targetprocessDiagnostic,
    }
  }
  console.error("Hosted MCP request failed:", error instanceof Error ? error.message : error)
  sendJson(res, 500, { error: "internal_server_error" })
  return {
    reason: "internal_server_error",
    securityFailure: false,
    failureStage: "mcp_transport",
    errorClass: error instanceof Error ? error.name : typeof error,
    errorMessage: safeErrorMessage(error),
  }
}

function normalizedRoute(config: HostedConfig, url: URL): string {
  if (url.pathname === "/healthz") return "/healthz"
  if (url.pathname === config.metricsPath) return config.metricsPath
  if (url.pathname === metadataPathForResource(config.resource) || url.pathname === "/.well-known/oauth-protected-resource") {
    return "/.well-known/oauth-protected-resource"
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") return "/.well-known/oauth-authorization-server"
  if (url.pathname === "/oauth/authorize") return "/oauth/authorize"
  if (url.pathname === "/oauth/callback") return "/oauth/callback"
  if (url.pathname === "/oauth/token") return "/oauth/token"
  if (url.pathname === "/account/targetprocess") return "/account/targetprocess"
  if (url.pathname === config.mcpPath) return config.mcpPath
  return "not_found"
}

function clientIp(config: HostedConfig, req: IncomingMessage): string {
  if (config.trustProxyHeaders) {
    const forwarded = headerValue(req.headers["x-forwarded-for"])?.split(",")[0]?.trim()
    if (forwarded) return normalizeIp(forwarded)
    const realIp = headerValue(req.headers["x-real-ip"])?.trim()
    if (realIp) return normalizeIp(realIp)
  }
  return normalizeIp(req.socket.remoteAddress || "unknown")
}

function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value
}

function statusReason(status: number): string {
  if (status === 400) return "bad_request"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 405) return "method_not_allowed"
  if (status >= 500) return "internal_server_error"
  return "ok"
}

function statusClassLabel(status: number): string {
  return `${Math.floor(status / 100)}xx`
}

function isSecurityFailure(status: number, reason: string): boolean {
  if (status === 401 || status === 403) return true
  return reason === "invalid_host" || reason === "https_required" || reason === "invalid_origin"
}

function failureStageForHttp(
  route: string,
  reason: string,
  securityFailure: boolean,
  targetprocessDiagnostic?: TpRequestDiagnostic,
): FailureStage {
  if (targetprocessDiagnostic) return "targetprocess_api"
  if (securityFailure || reason === "invalid_token" || reason === "invalid_metrics_token") return "auth"
  if (route.startsWith("/oauth/")) return "oauth"
  if (route === "/account/targetprocess" || reason.startsWith("targetprocess_credentials")) return "account"
  return "mcp_transport"
}

function targetprocessFailureReason(diagnostic: TpRequestDiagnostic): string {
  if (diagnostic.message.includes("HTTP error! status:")) return "targetprocess_http_error"
  if (diagnostic.message.includes("Failed to parse Targetprocess JSON response")) return "targetprocess_json_parse_error"
  if (diagnostic.message === "TP_TOKEN is required" || diagnostic.message === "Targetprocess OpenToken is required") {
    return "targetprocess_auth_missing"
  }
  return "targetprocess_network_error"
}

function toolFailureReason(outcome: "failure" | "denied", reason: string | undefined): string {
  if (outcome === "denied") {
    return reasonCode(reason) || "policy_denied"
  }
  return "tool_exception"
}

function reasonCode(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  if (reason.startsWith("Rate limit exceeded")) return "rate_limit_exceeded"
  if (reason.includes("disabled in your Targetprocess MCP settings")) return "policy_disabled"
  if (reason.includes("not available when using the service Targetprocess token")) return "shared_token_policy"
  return reason.slice(0, 120)
}

function targetprocessPath(diagnostic: TpRequestDiagnostic | undefined): string | undefined {
  if (!diagnostic?.url) return undefined
  try {
    return new URL(diagnostic.url).pathname
  } catch {
    return undefined
  }
}

function targetprocessDiagnosticFromError(error: unknown): TpRequestDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined
  const diagnostic = (error as { targetprocessDiagnostic?: TpRequestDiagnostic }).targetprocessDiagnostic
  return diagnostic && typeof diagnostic.method === "string" && typeof diagnostic.url === "string"
    ? diagnostic
    : undefined
}

function markHandledFailure(audit: RequestAuditInfo, error: unknown, reason: string, failureStage: FailureStage): void {
  audit.reason = reason
  audit.failureStage = failureStage
  audit.targetprocessDiagnostic = targetprocessDiagnosticFromError(error)
}

function withTargetprocessDiagnostic(error: OAuthHttpError, diagnostic: TpRequestDiagnostic | undefined): OAuthHttpError {
  if (diagnostic) {
    ;(error as { targetprocessDiagnostic?: TpRequestDiagnostic }).targetprocessDiagnostic = diagnostic
  }
  return error
}

function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined
  return error.message
    .replace(/access_token=[^&\s"]*/g, "access_token=***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ***")
    .replace(/("?(?:token|code|client_secret|refresh_token|access_token)"?\s*[:=]\s*)("[^"]+"|[^&\s"]+)/gi, "$1***")
    .slice(0, 160)
}

function accountPage({
  email,
  account,
  sharedTokenAvailable,
  clientName,
  csrf,
  message,
  messageKind,
  personalAccessTokensUrl,
  resume,
  oauthResume,
  tokenInvalid,
}: {
  email: string
  account: TargetprocessAccount
  sharedTokenAvailable: boolean
  clientName: string
  csrf: string
  message: string
  messageKind: "info" | "error"
  personalAccessTokensUrl: string
  resume: string
  oauthResume: string
  tokenInvalid: boolean
}): string {
  const policy = account.accessMode === "shared" ? sharedTokenPolicy : normalizePolicy(account.policy)
  const hiddenResume = hiddenResumeFields(resume, oauthResume)
  const hasPersonalToken = account.credential?.kind === "targetprocess_access_token"
  const isShared = account.accessMode === "shared"
  const mode = oauthResume ? "oauth_connect" : "account_settings"
  const accessChoice: AccessMode = hasPersonalToken ? "personal" : sharedTokenAvailable ? "shared" : "personal"
  const canFinish = Boolean(oauthResume && !tokenInvalid && (hasPersonalToken || sharedTokenAvailable || account.credential))
  const view = {
    mode,
    accessChoice,
    canFinish,
    hasPersonalToken,
    sharedTokenAvailable,
    clientName,
    tokenInvalid,
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Targetprocess MCP</title>
  <style>
    :root { color-scheme: light; --ink: #17202a; --muted: #5b6773; --line: #cfd7df; --soft: #f5f7f9; --ok: #eef6ee; --err: #fdecec; --accent: #155e75; }
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1rem; color: var(--ink); background: #fff; }
    h1 { margin: 0 0 .5rem; font-size: 2rem; line-height: 1.15; }
    h2 { margin: 1.5rem 0 .5rem; font-size: 1.2rem; }
    h3 { margin: 0 0 .35rem; font-size: 1rem; }
    p { margin: .45rem 0; }
    label, input, button, select { box-sizing: border-box; }
    label { display: block; margin: .6rem 0 .25rem; font-weight: 600; }
    input[type="password"], input[type="number"], select { width: 100%; margin: .2rem 0 1rem; padding: .65rem; border: 1px solid var(--line); border-radius: 6px; }
    .check label { display: flex; gap: .5rem; align-items: center; font-weight: 400; margin: .45rem 0; }
    button { width: auto; padding: .65rem .9rem; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: white; font-weight: 700; cursor: pointer; }
    button.secondary { border-color: var(--line); background: white; color: var(--ink); }
    .status { margin: 1rem 0; padding: .75rem; background: var(--ok); border-radius: 6px; }
    .error { margin: 1rem 0; padding: .75rem; background: var(--err); border-radius: 6px; }
    fieldset { margin: 1.25rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: 6px; }
    legend { font-weight: 700; }
    .muted { color: var(--muted); }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
    .danger { margin-top: 1rem; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; margin: 1rem 0; }
    .summary div, .option, .ready { border: 1px solid var(--line); border-radius: 6px; padding: .9rem; background: var(--soft); }
    .summary strong { display: block; margin-top: .15rem; }
    .option { margin: .75rem 0; background: #fff; }
    .option label { display: flex; gap: .5rem; align-items: flex-start; margin: 0; }
    .option-body { margin-top: .75rem; }
    .token-panel { display: none; }
    .option:has(input[data-toggle-panel]:checked) .token-panel { display: block; }
    details { margin: 1rem 0; }
    summary { cursor: pointer; font-weight: 700; }
    .readonly-list { margin: .75rem 0 0; padding-left: 1.25rem; }
    .step { font-size: .9rem; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    @media (max-width: 620px) { body { margin-top: 1.5rem; } .summary { grid-template-columns: 1fr; } .actions button { width: 100%; } }
  </style>
</head>
<body>
  ${message ? `<p class="${messageKind === "error" ? "error" : "status"}">${escapeHtml(message)}</p>` : ""}
  ${view.mode === "oauth_connect"
    ? oauthConnectContent({ email, csrf, hiddenResume, personalAccessTokensUrl, policy, view })
    : accountSettingsContent({ email, csrf, hiddenResume, personalAccessTokensUrl, policy, hasPersonalToken, isShared, sharedTokenAvailable })}
</body>
</html>`
}

function oauthConnectContent({
  email,
  csrf,
  hiddenResume,
  personalAccessTokensUrl,
  policy,
  view,
}: {
  email: string
  csrf: string
  hiddenResume: string
  personalAccessTokensUrl: string
  policy: TargetprocessAccessPolicy
  view: {
    accessChoice: AccessMode
    canFinish: boolean
    hasPersonalToken: boolean
    sharedTokenAvailable: boolean
    clientName: string
    tokenInvalid: boolean
  }
}): string {
  const client = view.clientName || "your MCP client"
  if (view.tokenInvalid) {
    return `
      <p class="step">Step 1 of 1</p>
      <h1>Connect Targetprocess MCP</h1>
      <p>Signed in as ${escapeHtml(email)}. Save a current Targetprocess personal access token to continue to ${escapeHtml(client)}.</p>
      ${personalTokenFinishForm({ csrf, hiddenResume, personalAccessTokensUrl, policy, autofocus: true, buttonLabel: "Save token and continue" })}`
  }
  if (view.hasPersonalToken && view.canFinish) {
    return `
      <p class="step">Ready to connect</p>
      <h1>Connect Targetprocess MCP</h1>
      <p>Signed in as ${escapeHtml(email)}. Your saved Targetprocess personal token is ready for this connection.</p>
      <form method="post" class="ready">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="action" value="finish_oauth">
        ${hiddenResume}
        <button type="submit">Continue to ${escapeHtml(client)}</button>
      </form>`
  }
  return `
    <p class="step">Choose access</p>
    <h1>Connect Targetprocess MCP</h1>
    <p>Signed in as ${escapeHtml(email)}. Choose how this MCP connection should access Targetprocess.</p>
    <form method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${hiddenResume}
      ${view.sharedTokenAvailable ? `
      <section class="option">
        <label>
          <input type="radio" name="access_mode" value="shared" data-toggle-panel${view.accessChoice === "shared" ? " checked" : ""}>
          <span><strong>Limited service access</strong><br><span class="muted">Read, search, list, and add attributed comments. Create, update, delete, attachment, relation, label, test, and time logging tools stay unavailable.</span></span>
        </label>
        <div class="option-body token-panel" data-panel="shared">
          <div class="actions">
            <button type="submit" name="action" value="finish_shared_oauth">Continue to ${escapeHtml(client)}</button>
          </div>
        </div>
      </section>` : ""}
      <section class="option">
        <label>
          <input type="radio" name="access_mode" value="personal" data-toggle-panel${view.accessChoice === "personal" ? " checked" : ""}>
          <span><strong>Use my personal token</strong><br><span class="muted">Use your Targetprocess permissions and optional agent permission limits.</span></span>
        </label>
        <div class="option-body token-panel" data-panel="personal">
          ${personalTokenFields(personalAccessTokensUrl, !view.sharedTokenAvailable)}
          <details>
            <summary>Customize personal-token permissions</summary>
            ${policyFields(policy)}
          </details>
          <div class="actions">
            <button type="submit" name="action" value="save_personal_finish_oauth">Save token and continue</button>
          </div>
        </div>
      </section>
    </form>`
}

function accountSettingsContent({
  email,
  csrf,
  hiddenResume,
  personalAccessTokensUrl,
  policy,
  hasPersonalToken,
  isShared,
  sharedTokenAvailable,
}: {
  email: string
  csrf: string
  hiddenResume: string
  personalAccessTokensUrl: string
  policy: TargetprocessAccessPolicy
  hasPersonalToken: boolean
  isShared: boolean
  sharedTokenAvailable: boolean
}): string {
  return `
    <h1>Targetprocess MCP account settings</h1>
    <p>Signed in as ${escapeHtml(email)}.</p>
    <div class="summary">
      <div>Current access mode<strong>${isShared ? "Limited service access" : "Personal Targetprocess token"}</strong></div>
      <div>Personal token status<strong>${hasPersonalToken ? "saved" : "not saved"}</strong></div>
    </div>
    <form method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${hiddenResume}
      <fieldset>
        <legend>Access mode</legend>
        <label for="access_mode">Token mode</label>
        <select id="access_mode" name="access_mode">
          <option value="shared"${isShared ? " selected" : ""}${sharedTokenAvailable ? "" : " disabled"}>Limited service access</option>
          <option value="personal"${!isShared ? " selected" : ""}>Personal Targetprocess token</option>
        </select>
        ${sharedTokenAvailable ? "" : `<p class="muted">Service token mode is not configured on this server.</p>`}
      </fieldset>
      ${isShared ? sharedPermissionsSummary() : policyFields(policy)}
      <div class="actions">
        <button type="submit" name="action" value="settings">Save settings</button>
      </div>
    </form>
    <details>
      <summary>Replace personal token</summary>
      <form method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        ${hiddenResume}
        ${personalTokenFields(personalAccessTokensUrl, false)}
        <button type="submit" name="action" value="token">Save personal token and settings</button>
      </form>
    </details>
    ${hasPersonalToken ? `
    <form class="danger" method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="action" value="revoke">
      ${hiddenResume}
      <button class="secondary" type="submit">Revoke personal token</button>
    </form>` : ""}
    <form class="danger" method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="action" value="deregister">
      <button class="secondary" type="submit">Deregister and sign out</button>
    </form>`
}

function hiddenResumeFields(resume: string, oauthResume: string): string {
  return [
    resume ? `<input type="hidden" name="resume" value="${escapeHtml(resume)}">` : "",
    oauthResume ? `<input type="hidden" name="oauth_resume" value="${escapeHtml(oauthResume)}">` : "",
  ].join("")
}

function policyFields(policy: TargetprocessAccessPolicy): string {
  return `<fieldset>
    <legend>Agent permissions</legend>
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

function personalTokenFinishForm({
  csrf,
  hiddenResume,
  personalAccessTokensUrl,
  policy,
  autofocus,
  buttonLabel,
}: {
  csrf: string
  hiddenResume: string
  personalAccessTokensUrl: string
  policy: TargetprocessAccessPolicy
  autofocus: boolean
  buttonLabel: string
}): string {
  return `<form method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    ${hiddenResume}
    ${personalTokenFields(personalAccessTokensUrl, autofocus)}
    <details>
      <summary>Customize personal-token permissions</summary>
      ${policyFields(policy)}
    </details>
    <button type="submit" name="action" value="save_personal_finish_oauth">${escapeHtml(buttonLabel)}</button>
  </form>`
}

function personalTokenFields(personalAccessTokensUrl: string, autofocus: boolean): string {
  return `<p class="muted">
    Open <a href="${escapeHtml(personalAccessTokensUrl)}" target="_blank" rel="noopener noreferrer">Targetprocess personal access tokens</a>
    in a new tab to create or copy a personal token.
  </p>
  <label for="token">Targetprocess personal access token</label>
  <input id="token" name="token" type="password" autocomplete="off"${autofocus ? " autofocus" : ""}>`
}

function sharedPermissionsSummary(): string {
  return `<section>
    <h2>Agent permissions</h2>
    <p class="muted">Service-token mode uses fixed server-side permissions.</p>
    <ul class="readonly-list">
      <li>Read, search, get, and list tools are available.</li>
      <li>Comments are available with a limit of ${sharedTokenPolicy.commentLimitPerHour} per hour.</li>
      <li>Create, update, delete, attachment, label, relation, test write, and time logging tools are unavailable.</li>
    </ul>
  </section>`
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

function tokenRequestClientId(form: URLSearchParams, authorizationHeader: string | string[] | undefined): string | undefined {
  const basic = headerValue(authorizationHeader)?.match(/^Basic\s+(.+)$/i)?.[1]
  if (basic) {
    try {
      const decoded = Buffer.from(basic, "base64").toString("utf8")
      const separator = decoded.indexOf(":")
      return (separator >= 0 ? decoded.slice(0, separator) : decoded).slice(0, 120) || undefined
    } catch {
      return undefined
    }
  }
  return reasonCode(form.get("client_id") || undefined)
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
