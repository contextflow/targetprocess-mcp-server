import { createPublicKey } from "crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import type { HostedConfig, OAuthClientConfig } from "./config.js"
import {
  audienceMatches,
  decodeJwtClaims,
  decodeJwtHeader,
  randomBase64Url,
  safeEqual,
  signJwt,
  verifyAsymmetricJwtSignature,
  verifyHmacJwt,
  verifyPkce,
  type JwtClaims,
} from "./security.js"

export type AuthenticatedMcpRequest = {
  userId: string
  email: string
  name?: string
  clientId: string
  scopes: string[]
}

export type OAuthUser = {
  id: string
  email: string
  name?: string
  groups: string[]
}

type PendingAuthorization = {
  kind: "oauth"
  clientId: string
  redirectUri: string
  requestedScope: string[]
  clientState?: string
  codeChallenge: string
  nonce: string
  createdAt: number
}

type PendingAccountLogin = {
  kind: "account"
  nonce: string
  createdAt: number
}

type PendingLogin = PendingAuthorization | PendingAccountLogin

export type OAuthAuthorizationResume = {
  user: OAuthUser
  clientId: string
  redirectUri: string
  scopes: string[]
  clientState?: string
  codeChallenge: string
}

type AuthorizationCode = {
  user: OAuthUser
  clientId: string
  redirectUri: string
  codeChallenge: string
  scopes: string[]
  expiresAt: number
}

type RefreshGrant = {
  user: OAuthUser
  clientId: string
  scopes: string[]
  expiresAt: number
}

type OAuthStateFile = {
  version: 1
  pending: Record<string, PendingLogin>
  codes: Record<string, AuthorizationCode>
  refreshTokens: Record<string, RefreshGrant>
}

export class OAuthBroker {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly codes = new Map<string, AuthorizationCode>()
  private readonly refreshTokens = new Map<string, RefreshGrant>()
  private jwksCache: { expiresAt: number; keys: Record<string, unknown>[] } | undefined

  constructor(private readonly config: HostedConfig) {
    this.loadState()
  }

  buildAuthorizationRedirect(requestUrl: URL): string {
    this.cleanup()
    const client = this.requireClient(requestUrl.searchParams.get("client_id") || "")
    const redirectUri = requestUrl.searchParams.get("redirect_uri") || ""
    const responseType = requestUrl.searchParams.get("response_type") || ""
    const codeChallenge = requestUrl.searchParams.get("code_challenge") || ""
    const codeChallengeMethod = requestUrl.searchParams.get("code_challenge_method") || ""
    const requestedScope = this.normalizeScopes(client, requestUrl.searchParams.get("scope"))

    if (responseType !== "code") throw new OAuthHttpError(400, "unsupported_response_type")
    if (!redirectUriAllowed(client, redirectUri)) throw new OAuthHttpError(400, "invalid_redirect_uri")
    if (!codeChallenge || codeChallengeMethod !== "S256") throw new OAuthHttpError(400, "invalid_pkce")

    const state = randomBase64Url(32)
    const nonce = randomBase64Url(32)
    this.pending.set(state, {
      kind: "oauth",
      clientId: client.clientId,
      redirectUri,
      requestedScope,
      clientState: requestUrl.searchParams.get("state") || undefined,
      codeChallenge,
      nonce,
      createdAt: Date.now(),
    })
    this.persistState()

    return this.oidcAuthorizationUrl(state, nonce)
  }

  buildAccountLoginRedirect(): string {
    this.cleanup()
    const state = randomBase64Url(32)
    const nonce = randomBase64Url(32)
    this.pending.set(state, {
      kind: "account",
      nonce,
      createdAt: Date.now(),
    })
    this.persistState()
    return this.oidcAuthorizationUrl(state, nonce)
  }

  async completeOidcCallback(requestUrl: URL): Promise<
    | ({ kind: "oauth" } & OAuthAuthorizationResume)
    | { kind: "account"; sessionToken: string; user: OAuthUser }
  > {
    this.cleanup()
    const state = requestUrl.searchParams.get("state") || ""
    const oidcCode = requestUrl.searchParams.get("code") || ""
    const pending = this.pending.get(state)
    this.pending.delete(state)
    this.persistState()

    if (!pending || !oidcCode) throw new OAuthHttpError(400, "invalid_oidc_callback")

    const user = await this.exchangeAndVerifyOidcUser(oidcCode, pending.nonce)
    return this.completePendingLogin(pending, user)
  }

  private completePendingLogin(
    pending: PendingLogin,
    user: OAuthUser,
  ): ({ kind: "oauth" } & OAuthAuthorizationResume) | { kind: "account"; sessionToken: string; user: OAuthUser } {
    if (pending.kind === "account") {
      return {
        kind: "account",
        sessionToken: this.createAccountSession(user),
        user,
      }
    }

    return {
      kind: "oauth",
      user,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.requestedScope,
      clientState: pending.clientState,
    }
  }

  buildClientAuthorizationRedirect(resume: OAuthAuthorizationResume): string {
    const code = randomBase64Url(32)
    this.codes.set(code, {
      user: resume.user,
      clientId: resume.clientId,
      redirectUri: resume.redirectUri,
      codeChallenge: resume.codeChallenge,
      scopes: resume.scopes,
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
    this.persistState()

    const redirectUrl = new URL(resume.redirectUri)
    redirectUrl.searchParams.set("code", code)
    if (resume.clientState) redirectUrl.searchParams.set("state", resume.clientState)
    return redirectUrl.toString()
  }

  exchangeToken(form: URLSearchParams, authorizationHeader?: string): Record<string, unknown> {
    this.cleanup()
    const grantType = form.get("grant_type") || ""
    if (grantType === "authorization_code") {
      return this.exchangeAuthorizationCode(form, authorizationHeader)
    }
    if (grantType === "refresh_token") {
      return this.exchangeRefreshToken(form, authorizationHeader)
    }
    throw new OAuthHttpError(400, "unsupported_grant_type")
  }

  authenticateBearer(authorizationHeader?: string): AuthenticatedMcpRequest {
    const token = bearerToken(authorizationHeader)
    let claims: JwtClaims
    try {
      claims = verifyHmacJwt(token, this.config.signingKey, {
        issuer: this.config.oauthIssuer,
        audience: this.config.resource,
      })
    } catch {
      throw new OAuthHttpError(401, "invalid_token")
    }
    const clientId = stringClaim(claims.client_id, "client_id")
    this.requireClient(clientId)
    return {
      userId: stringClaim(claims.sub, "sub"),
      email: stringClaim(claims.email, "email"),
      name: typeof claims.name === "string" ? claims.name : undefined,
      clientId,
      scopes: Array.isArray(claims.scope) ? claims.scope.filter((item): item is string => typeof item === "string") : [],
    }
  }

  createAccountSession(user: OAuthUser): string {
    return signJwt({
      sub: user.id,
      aud: `${this.config.resource}:account`,
      email: user.email,
      name: user.name,
      csrf: randomBase64Url(24),
      typ: "account_session",
    }, this.config.signingKey, {
      issuer: this.config.oauthIssuer,
      expiresInSeconds: 60 * 60 * 8,
    })
  }

  verifyAccountSession(sessionToken: string): { user: OAuthUser; csrf: string } {
    let claims: JwtClaims
    try {
      claims = verifyHmacJwt(sessionToken, this.config.signingKey, {
        issuer: this.config.oauthIssuer,
        audience: `${this.config.resource}:account`,
      })
    } catch {
      throw new OAuthHttpError(401, "invalid_account_session")
    }
    return {
      user: {
        id: stringClaim(claims.sub, "sub"),
        email: stringClaim(claims.email, "email"),
        name: typeof claims.name === "string" ? claims.name : undefined,
        groups: [],
      },
      csrf: stringClaim(claims.csrf, "csrf"),
    }
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.config.oauthIssuer,
      authorization_endpoint: new URL("/oauth/authorize", this.config.publicUrl).toString(),
      token_endpoint: new URL("/oauth/token", this.config.publicUrl).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: ["mcp:tools"],
    }
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.oauthIssuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:tools"],
    }
  }

  wwwAuthenticateHeader(): string {
    const metadataUrl = new URL(`/.well-known/oauth-protected-resource${new URL(this.config.resource).pathname}`, this.config.publicUrl)
    return `Bearer resource_metadata="${metadataUrl.toString()}", scope="mcp:tools"`
  }

  private exchangeAuthorizationCode(form: URLSearchParams, authorizationHeader?: string): Record<string, unknown> {
    const client = this.authenticateClient(form, authorizationHeader)
    const code = form.get("code") || ""
    const redirectUri = form.get("redirect_uri") || ""
    const codeVerifier = form.get("code_verifier") || ""
    const grant = this.codes.get(code)
    this.codes.delete(code)
    this.persistState()

    if (!grant || grant.expiresAt <= Date.now()) throw new OAuthHttpError(400, "invalid_grant")
    if (grant.clientId !== client.clientId || grant.redirectUri !== redirectUri) {
      throw new OAuthHttpError(400, "invalid_grant")
    }
    if (!verifyPkce(grant.codeChallenge, codeVerifier)) throw new OAuthHttpError(400, "invalid_grant")
    return this.issueTokens(grant.user, client.clientId, grant.scopes)
  }

  private exchangeRefreshToken(form: URLSearchParams, authorizationHeader?: string): Record<string, unknown> {
    const client = this.authenticateClient(form, authorizationHeader)
    const refreshToken = form.get("refresh_token") || ""
    const grant = this.refreshTokens.get(refreshToken)
    this.refreshTokens.delete(refreshToken)
    this.persistState()

    if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== client.clientId) {
      throw new OAuthHttpError(400, "invalid_grant")
    }
    return this.issueTokens(grant.user, client.clientId, grant.scopes)
  }

  private issueTokens(user: OAuthUser, clientId: string, scopes: string[]): Record<string, unknown> {
    const refreshToken = randomBase64Url(48)
    this.refreshTokens.set(refreshToken, {
      user,
      clientId,
      scopes,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    this.persistState()

    const accessToken = signJwt({
      sub: user.id,
      aud: this.config.resource,
      email: user.email,
      name: user.name,
      client_id: clientId,
      scope: scopes,
      typ: "access_token",
    }, this.config.signingKey, {
      issuer: this.config.oauthIssuer,
      expiresInSeconds: 60 * 15,
    })

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 60 * 15,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    }
  }

  private authenticateClient(form: URLSearchParams, authorizationHeader?: string): OAuthClientConfig {
    const basic = parseBasicAuth(authorizationHeader)
    const clientId = basic?.clientId || form.get("client_id") || ""
    const client = this.requireClient(clientId)
    const providedSecret = basic?.clientSecret || form.get("client_secret") || ""
    if (client.clientSecret && !safeEqual(client.clientSecret, providedSecret)) {
      throw new OAuthHttpError(401, "invalid_client")
    }
    return client
  }

  private requireClient(clientId: string): OAuthClientConfig {
    const client = this.config.oauthClients.get(clientId)
    if (!client) throw new OAuthHttpError(400, "invalid_client")
    return client
  }

  private normalizeScopes(client: OAuthClientConfig, requestedScope: string | null): string[] {
    const requested = (requestedScope || client.scopes.join(" "))
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
    const unique = [...new Set(requested)]
    for (const scope of unique) {
      if (!client.scopes.includes(scope)) throw new OAuthHttpError(400, "invalid_scope")
    }
    return unique
  }

  private oidcAuthorizationUrl(state: string, nonce: string): string {
    const oidc = this.requireOidc()
    const url = new URL(oidc.metadata.authorizationEndpoint)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", oidc.clientId)
    url.searchParams.set("redirect_uri", oidc.redirectUri)
    url.searchParams.set("scope", oidc.scopes.join(" "))
    url.searchParams.set("state", state)
    url.searchParams.set("nonce", nonce)
    if (oidc.allowedHostedDomains.length > 0) {
      url.searchParams.set("hd", oidc.allowedHostedDomains[0])
    }
    return url.toString()
  }

  private async exchangeAndVerifyOidcUser(code: string, nonce: string): Promise<OAuthUser> {
    const oidc = this.requireOidc()
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidc.redirectUri,
      client_id: oidc.clientId,
      client_secret: oidc.clientSecret,
    })

    const response = await fetch(oidc.metadata.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
    })
    if (!response.ok) throw new OAuthHttpError(401, "oidc_token_exchange_failed")
    const tokenResponse = await response.json() as { id_token?: string }
    if (!tokenResponse.id_token) throw new OAuthHttpError(401, "oidc_id_token_missing")

    await this.verifyOidcJwt(tokenResponse.id_token, nonce)
    const claims = decodeJwtClaims(tokenResponse.id_token)
    const email = stringClaim(claims.email, "email").toLowerCase()
    this.assertOrgUser(email, claims)
    return {
      id: stringClaim(claims.sub, "sub"),
      email,
      name: typeof claims.name === "string" ? claims.name : undefined,
      groups: arrayClaim(claims.groups),
    }
  }

  private async verifyOidcJwt(token: string, nonce: string): Promise<void> {
    const oidc = this.requireOidc()
    const header = decodeJwtHeader(token)
    const alg = stringClaim(header.alg, "alg")
    const kid = typeof header.kid === "string" ? header.kid : undefined
    const keys = await this.getJwks()
    const jwk = keys.find((candidate) => !kid || candidate.kid === kid)
    if (!jwk) throw new OAuthHttpError(401, "oidc_jwk_not_found")

    verifyAsymmetricJwtSignature(token, createPublicKey({ key: jwk, format: "jwk" }), alg)
    const claims = decodeJwtClaims(token)
    const now = Math.floor(Date.now() / 1000)
    if (claims.iss !== oidc.metadata.issuer) throw new OAuthHttpError(401, "oidc_bad_issuer")
    if (!audienceMatches(claims.aud, oidc.clientId)) throw new OAuthHttpError(401, "oidc_bad_audience")
    if (typeof claims.exp !== "number" || claims.exp <= now) throw new OAuthHttpError(401, "oidc_expired")
    if (claims.nonce !== nonce) throw new OAuthHttpError(401, "oidc_bad_nonce")
    if (claims.email_verified === false) throw new OAuthHttpError(403, "oidc_email_not_verified")
    if ((oidc.allowedDomains.length > 0 || oidc.allowedHostedDomains.length > 0) && claims.email_verified !== true) {
      throw new OAuthHttpError(403, "oidc_email_not_verified")
    }
  }

  private async getJwks(): Promise<Record<string, unknown>[]> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) return this.jwksCache.keys
    const response = await fetch(this.requireOidc().metadata.jwksUri, { redirect: "error" })
    if (!response.ok) throw new OAuthHttpError(401, "oidc_jwks_fetch_failed")
    const jwks = await response.json() as { keys?: Record<string, unknown>[] }
    if (!Array.isArray(jwks.keys)) throw new OAuthHttpError(401, "oidc_jwks_invalid")
    this.jwksCache = { keys: jwks.keys, expiresAt: Date.now() + 10 * 60 * 1000 }
    return jwks.keys
  }

  private assertOrgUser(email: string, claims: Record<string, unknown>): void {
    const oidc = this.requireOidc()
    if (oidc.allowedDomains.length > 0) {
      const domain = email.split("@")[1] || ""
      if (!oidc.allowedDomains.includes(domain)) {
        throw new OAuthHttpError(403, "org_domain_required")
      }
    }

    if (oidc.allowedHostedDomains.length > 0) {
      const hostedDomain = typeof claims.hd === "string" ? claims.hd.toLowerCase() : ""
      if (!oidc.allowedHostedDomains.includes(hostedDomain)) {
        throw new OAuthHttpError(403, "org_hosted_domain_required")
      }
    }

    if (oidc.allowedGroups.length > 0) {
      const groups = new Set([...arrayClaim(claims.groups), ...arrayClaim(claims.roles)])
      if (!oidc.allowedGroups.some((group) => groups.has(group))) {
        throw new OAuthHttpError(403, "org_group_required")
      }
    }
  }

  private requireOidc(): NonNullable<HostedConfig["oidc"]> {
    return this.config.oidc
  }

  private cleanup(): void {
    const now = Date.now()
    let changed = false
    for (const [key, value] of this.pending) {
      if (value.createdAt + 10 * 60 * 1000 <= now) {
        this.pending.delete(key)
        changed = true
      }
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt <= now) {
        this.codes.delete(key)
        changed = true
      }
    }
    for (const [key, value] of this.refreshTokens) {
      if (value.expiresAt <= now) {
        this.refreshTokens.delete(key)
        changed = true
      }
    }
    if (changed) this.persistState()
  }

  private loadState(): void {
    const path = this.config.oauthStateStorePath
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as OAuthStateFile
      if (parsed.version !== 1) return
      for (const [key, value] of Object.entries(parsed.pending || {})) this.pending.set(key, value)
      for (const [key, value] of Object.entries(parsed.codes || {})) this.codes.set(key, value)
      for (const [key, value] of Object.entries(parsed.refreshTokens || {})) this.refreshTokens.set(key, value)
      this.cleanup()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  private persistState(): void {
    const path = this.config.oauthStateStorePath
    if (!path) return
    const state: OAuthStateFile = {
      version: 1,
      pending: Object.fromEntries(this.pending),
      codes: Object.fromEntries(this.codes),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(tempPath, path)
  }
}

export function redirectUriAllowed(client: OAuthClientConfig, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true

  let actual: URL
  try {
    actual = new URL(redirectUri)
  } catch {
    return false
  }

  for (const rawRegistered of client.redirectUris) {
    let registered: URL
    try {
      registered = new URL(rawRegistered)
    } catch {
      continue
    }

    if (!isLoopbackHost(registered.hostname)) continue
    if (registered.protocol !== actual.protocol) continue
    if (registered.hostname !== actual.hostname) continue
    if (registered.port && registered.port !== actual.port) continue
    if (!actual.port) continue

    const prefix = registered.pathname.endsWith("/")
      ? registered.pathname
      : `${registered.pathname}/`
    if (actual.pathname === registered.pathname || actual.pathname.startsWith(prefix)) return true
  }

  return false
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
}

export class OAuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

function bearerToken(authorizationHeader?: string): string {
  const [scheme, token] = (authorizationHeader || "").split(/\s+/, 2)
  if (scheme !== "Bearer" || !token) throw new OAuthHttpError(401, "invalid_token")
  return token
}

function parseBasicAuth(authorizationHeader?: string): { clientId: string; clientSecret: string } | undefined {
  const [scheme, token] = (authorizationHeader || "").split(/\s+/, 2)
  if (scheme !== "Basic" || !token) return undefined
  const decoded = Buffer.from(token, "base64").toString("utf8")
  const delimiterIndex = decoded.indexOf(":")
  if (delimiterIndex < 0) return undefined
  return {
    clientId: decoded.slice(0, delimiterIndex),
    clientSecret: decoded.slice(delimiterIndex + 1),
  }
}

function stringClaim(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`JWT claim ${name} is required`)
  return value
}

function arrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}
