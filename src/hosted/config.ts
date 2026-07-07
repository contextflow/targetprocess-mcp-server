import { config as appConfig } from "../config.js"
import { parseBase64Key } from "./security.js"

export type OAuthClientConfig = {
  clientId: string
  clientSecret?: string
  name: string
  redirectUris: string[]
  allowedOrigins: string[]
  scopes: string[]
}

export type OidcMetadata = {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
}

export type HostedConfig = {
  port: number
  publicUrl: string
  mcpPath: string
  mcpUrl: string
  oauthIssuer: string
  resource: string
  allowedOrigins: string[]
  requireHttps: boolean
  signingKey: Buffer
  tokenEncryptionKey: Buffer
  tokenStorePath: string
  tpBaseUrl: string
  tpPersonalAccessTokensUrl: string
  oauthClients: Map<string, OAuthClientConfig>
  oidc: {
    issuerUrl: string
    clientId: string
    clientSecret: string
    redirectUri: string
    scopes: string[]
    allowedDomains: string[]
    allowedGroups: string[]
    metadata: OidcMetadata
  }
}

type RawOAuthClient = {
  client_id?: string
  clientId?: string
  client_secret?: string
  clientSecret?: string
  name?: string
  redirect_uris?: string[]
  redirectUris?: string[]
  allowed_origins?: string[]
  allowedOrigins?: string[]
  scopes?: string[]
}

export async function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): Promise<HostedConfig> {
  const publicUrl = requireUrl(env.MCP_PUBLIC_URL, "MCP_PUBLIC_URL")
  const mcpPath = env.MCP_PATH?.trim() || "/mcp"
  const mcpUrl = new URL(mcpPath, publicUrl).toString()
  const oauthIssuer = removeTrailingSlash(env.MCP_OAUTH_ISSUER_URL?.trim() || publicUrl)
  const oidc = await loadOidcConfig(publicUrl, env)
  if (!appConfig.tp.url) throw new Error("TP_BASE_URL is required")
  const tpBaseUrl = appConfig.tp.url

  return {
    port: parsePositiveInteger(env.MCP_PORT, 3000, "MCP_PORT"),
    publicUrl,
    mcpPath,
    mcpUrl,
    oauthIssuer,
    resource: env.MCP_RESOURCE?.trim() || mcpUrl,
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS),
    requireHttps: env.MCP_REQUIRE_HTTPS !== "0",
    signingKey: parseBase64Key(requireEnv(env.MCP_SIGNING_KEY_B64, "MCP_SIGNING_KEY_B64"), 32, "MCP_SIGNING_KEY_B64"),
    tokenEncryptionKey: parseBase64Key(requireEnv(env.TP_TOKEN_ENCRYPTION_KEY_B64, "TP_TOKEN_ENCRYPTION_KEY_B64"), 32, "TP_TOKEN_ENCRYPTION_KEY_B64"),
    tokenStorePath: env.TP_TOKEN_STORE_PATH?.trim() || "/tmp/targetprocess-mcp-user-tokens.json",
    tpBaseUrl,
    tpPersonalAccessTokensUrl: personalAccessTokensUrl(tpBaseUrl),
    oauthClients: parseOAuthClients(requireEnv(env.MCP_OAUTH_CLIENTS_JSON, "MCP_OAUTH_CLIENTS_JSON")),
    oidc,
  }
}

export function metadataPathForResource(resource: string): string {
  const parsed = new URL(resource)
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname
  return `/.well-known/oauth-protected-resource${suffix}`
}

function parseOAuthClients(rawJson: string): Map<string, OAuthClientConfig> {
  const parsed = JSON.parse(rawJson) as RawOAuthClient[]
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MCP_OAUTH_CLIENTS_JSON must be a non-empty array")
  }

  const clients = new Map<string, OAuthClientConfig>()
  for (const rawClient of parsed) {
    const clientId = rawClient.clientId || rawClient.client_id
    const redirectUris = rawClient.redirectUris || rawClient.redirect_uris || []
    if (!clientId) throw new Error("Every MCP OAuth client requires client_id")
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new Error(`MCP OAuth client ${clientId} requires at least one redirect URI`)
    }
    clients.set(clientId, {
      clientId,
      clientSecret: rawClient.clientSecret || rawClient.client_secret,
      name: rawClient.name || clientId,
      redirectUris,
      allowedOrigins: rawClient.allowedOrigins || rawClient.allowed_origins || [],
      scopes: rawClient.scopes || ["mcp:tools"],
    })
  }
  return clients
}

async function discoverOidcMetadata(issuerUrl: string, env: NodeJS.ProcessEnv): Promise<OidcMetadata> {
  const explicitAuthorizationEndpoint = env.OIDC_AUTHORIZATION_ENDPOINT?.trim()
  const explicitTokenEndpoint = env.OIDC_TOKEN_ENDPOINT?.trim()
  const explicitJwksUri = env.OIDC_JWKS_URI?.trim()
  if (explicitAuthorizationEndpoint && explicitTokenEndpoint && explicitJwksUri) {
    return {
      issuer: issuerUrl,
      authorizationEndpoint: explicitAuthorizationEndpoint,
      tokenEndpoint: explicitTokenEndpoint,
      jwksUri: explicitJwksUri,
    }
  }

  const metadataUrl = new URL("/.well-known/openid-configuration", issuerUrl).toString()
  const response = await fetch(metadataUrl, { redirect: "error" })
  if (!response.ok) {
    throw new Error(`Failed to discover OIDC metadata from ${metadataUrl}: HTTP ${response.status}`)
  }

  const metadata = await response.json() as {
    issuer?: string
    authorization_endpoint?: string
    token_endpoint?: string
    jwks_uri?: string
  }

  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
    throw new Error(`OIDC metadata from ${metadataUrl} is missing required endpoints`)
  }

  return {
    issuer: metadata.issuer || issuerUrl,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    jwksUri: metadata.jwks_uri,
  }
}

async function loadOidcConfig(publicUrl: string, env: NodeJS.ProcessEnv): Promise<HostedConfig["oidc"]> {
  const oidcIssuerUrl = requireUrl(env.OIDC_ISSUER_URL, "OIDC_ISSUER_URL")
  const oidcMetadata = await discoverOidcMetadata(oidcIssuerUrl, env)
  return {
    issuerUrl: oidcIssuerUrl,
    clientId: requireEnv(env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID"),
    clientSecret: requireEnv(env.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET"),
    redirectUri: new URL("/oauth/callback", publicUrl).toString(),
    scopes: csv(env.OIDC_SCOPES || "openid,email,profile"),
    allowedDomains: csv(env.OIDC_ALLOWED_DOMAINS),
    allowedGroups: csv(env.OIDC_ALLOWED_GROUPS),
    metadata: oidcMetadata,
  }
}

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

function requireUrl(value: string | undefined, name: string): string {
  const trimmed = requireEnv(value, name)
  return parseHostedUrl(trimmed, name)
}

function parseHostedUrl(value: string, name: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use https:// in production`)
  }
  return removeTrailingSlash(parsed.toString())
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/$/, "")
}

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function personalAccessTokensUrl(tpBaseUrl: string): string {
  const url = new URL("/RestUI/Board.aspx", tpBaseUrl)
  url.hash = "page=settings/authAndSecurity/personalAccessTokensTab"
  return url.toString()
}
