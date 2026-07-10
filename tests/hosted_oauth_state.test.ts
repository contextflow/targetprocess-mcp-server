import { createSign, generateKeyPairSync } from 'crypto'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostedConfig } from '../src/hosted/config.js'
import { OAuthBroker, type OAuthAuthorizationResume } from '../src/hosted/oauth.js'
import { base64UrlEncode, sha256Base64Url } from '../src/hosted/security.js'

const oidcKeyId = 'test-key-1'
const oidcKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const oidcPublicJwk = {
  ...oidcKeys.publicKey.export({ format: 'jwk' }),
  kid: oidcKeyId,
  alg: 'RS256',
  use: 'sig',
}

function hostedConfig(oauthStateStorePath: string): HostedConfig {
  return {
    port: 3000,
    publicUrl: 'http://localhost:3000',
    mcpPath: '/mcp',
    mcpUrl: 'http://localhost:3000/mcp',
    metricsPath: '/metrics',
    metricsBearerToken: 'metrics-token',
    oauthIssuer: 'http://localhost:3000',
    resource: 'http://localhost:3000/mcp',
    allowedOrigins: [],
    trustProxyHeaders: false,
    requireHttps: false,
    signingKey: Buffer.alloc(32, 3),
    tokenEncryptionKey: Buffer.alloc(32, 4),
    tokenStorePath: '/tmp/tokens.json',
    oauthStateStorePath,
    tpBaseUrl: 'https://example.tpondemand.com',
    tpPersonalAccessTokensUrl: 'https://example.tpondemand.com/RestUI/Board.aspx#page=settings/authAndSecurity/personalAccessTokensTab',
    oauthClients: new Map([[
      'codex-local',
      {
        clientId: 'codex-local',
        name: 'Codex local',
        redirectUris: ['http://127.0.0.1/callback'],
        allowedOrigins: [],
        scopes: ['mcp:tools'],
      },
    ]]),
    oidc: {
      issuerUrl: 'https://idp.example.com',
      clientId: 'oidc-client',
      clientSecret: 'oidc-secret',
      redirectUri: 'http://localhost:3000/oauth/callback',
      scopes: ['openid', 'email', 'profile'],
      allowedDomains: [],
      allowedHostedDomains: [],
      allowedGroups: [],
      metadata: {
        issuer: 'https://idp.example.com',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        jwksUri: 'https://idp.example.com/jwks',
      },
    },
  }
}

describe('hosted OAuth state persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exchanges authorization codes created before a broker restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-oauth-state-'))
    const config = hostedConfig(join(dir, 'oauth-state.json'))
    const verifier = 'codex-local-verifier'
    const resume: OAuthAuthorizationResume = {
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri: 'http://127.0.0.1:48123/callback/random',
      scopes: ['mcp:tools'],
      clientState: 'client-state',
      codeChallenge: sha256Base64Url(verifier),
    }

    const redirect = new OAuthBroker(config).buildClientAuthorizationRedirect(resume)
    const code = new URL(redirect).searchParams.get('code') || ''

    const tokens = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: resume.redirectUri,
      client_id: 'codex-local',
      code_verifier: verifier,
    }))

    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'mcp:tools',
    })
    expect(tokens.access_token).toEqual(expect.any(String))
    expect(tokens.refresh_token).toEqual(expect.any(String))
  })

  it('uses configured access token TTLs in token responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-oauth-state-'))
    const config = hostedConfig(join(dir, 'oauth-state.json'))
    config.oauthClients.get('codex-local')!.accessTokenTtlSeconds = 60 * 60 * 8
    const verifier = 'codex-local-verifier'
    const redirectUri = 'http://127.0.0.1:48123/callback/random'
    const redirect = new OAuthBroker(config).buildClientAuthorizationRedirect({
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri,
      scopes: ['mcp:tools'],
      codeChallenge: sha256Base64Url(verifier),
    })
    const code = new URL(redirect).searchParams.get('code') || ''

    const tokens = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: 'codex-local',
      code_verifier: verifier,
    }))

    expect(tokens.expires_in).toBe(28800)
  })

  it('keeps one previous refresh token valid until the client advances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-oauth-state-'))
    const statePath = join(dir, 'oauth-state.json')
    const config = hostedConfig(statePath)
    const verifier = 'codex-local-verifier'
    const redirectUri = 'http://127.0.0.1:48123/callback/random'
    const redirect = new OAuthBroker(config).buildClientAuthorizationRedirect({
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri,
      scopes: ['mcp:tools'],
      codeChallenge: sha256Base64Url(verifier),
    })
    const code = new URL(redirect).searchParams.get('code') || ''
    const initialTokens = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: 'codex-local',
      code_verifier: verifier,
    }))
    const refreshToken1 = String(initialTokens.refresh_token)
    const initialState = await readFile(statePath, 'utf8')
    expect(initialState).not.toContain(refreshToken1)
    expect(JSON.parse(initialState).refreshTokens).toHaveProperty(sha256Base64Url(refreshToken1))

    const refreshed2 = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken1,
      client_id: 'codex-local',
    }))
    const refreshToken2 = String(refreshed2.refresh_token)

    const refreshed3 = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken1,
      client_id: 'codex-local',
    }))
    const refreshToken3 = String(refreshed3.refresh_token)
    expect(refreshToken3).toEqual(expect.any(String))
    expect(refreshToken3).not.toBe(refreshToken2)

    const refreshed4 = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken3,
      client_id: 'codex-local',
    }))
    const refreshToken4 = String(refreshed4.refresh_token)

    expect(refreshToken4).toEqual(expect.any(String))
    expect(() => new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken1,
      client_id: 'codex-local',
    }))).toThrow('invalid_grant')
    expect(() => new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken2,
      client_id: 'codex-local',
    }))).toThrow('invalid_grant')

    const finalState = await readFile(statePath, 'utf8')
    expect(finalState).not.toContain(refreshToken1)
    expect(finalState).not.toContain(refreshToken2)
    expect(finalState).not.toContain(refreshToken3)
    expect(finalState).not.toContain(refreshToken4)
    expect(finalState).not.toContain('tokenResponse')
    expect(JSON.parse(finalState).refreshTokens).toHaveProperty(sha256Base64Url(refreshToken4))
  })

  it('migrates legacy raw refresh-token state to hashed refresh-token families', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-oauth-state-'))
    const statePath = join(dir, 'oauth-state.json')
    const config = hostedConfig(statePath)
    const legacyRefreshToken = 'legacy-refresh-token'
    await writeFile(statePath, JSON.stringify({
      version: 1,
      pending: {},
      codes: {},
      refreshTokens: {
        [legacyRefreshToken]: {
          user: { id: 'user-1', email: 'user@example.com', groups: [] },
          clientId: 'codex-local',
          scopes: ['mcp:tools'],
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
      },
      refreshReplays: {
        ignored: {
          clientId: 'codex-local',
          userId: 'user-1',
          tokenResponse: { refresh_token: 'must-not-persist' },
          expiresAt: Date.now() + 60_000,
        },
      },
    }))

    const refreshed = new OAuthBroker(config).exchangeToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: legacyRefreshToken,
      client_id: 'codex-local',
    }))
    const newRefreshToken = String(refreshed.refresh_token)
    const migratedState = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(migratedState)

    expect(newRefreshToken).toEqual(expect.any(String))
    expect(migratedState).not.toContain(legacyRefreshToken)
    expect(migratedState).not.toContain('must-not-persist')
    expect(migratedState).not.toContain('tokenResponse')
    expect(parsed.refreshReplays).toBeUndefined()
    expect(parsed.refreshTokens).toHaveProperty(sha256Base64Url(legacyRefreshToken))
    expect(parsed.refreshTokens).toHaveProperty(sha256Base64Url(newRefreshToken))
  })

  it('accepts a verified Google Workspace user with a matching hosted-domain claim', async () => {
    const { result, authorizationUrl } = await completeAccountLogin({
      email: 'User@Example.com',
      email_verified: true,
      hd: 'example.com',
    })

    expect(authorizationUrl.searchParams.get('hd')).toBe('example.com')
    expect(result).toMatchObject({
      kind: 'account',
      user: {
        id: 'google-user-1',
        email: 'user@example.com',
      },
    })
  })

  it('rejects a matching email domain without the Google hosted-domain claim', async () => {
    await expect(completeAccountLogin({
      email: 'user@example.com',
      email_verified: true,
    })).rejects.toThrow('org_hosted_domain_required')
  })

  it('rejects a matching email domain with the wrong Google hosted-domain claim', async () => {
    await expect(completeAccountLogin({
      email: 'user@example.com',
      email_verified: true,
      hd: 'other.example',
    })).rejects.toThrow('org_hosted_domain_required')
  })

  it('requires verified email when hosted organization checks are configured', async () => {
    await expect(completeAccountLogin({
      email: 'user@example.com',
      hd: 'example.com',
    })).rejects.toThrow('oidc_email_not_verified')
  })
})

async function completeAccountLogin(claims: Record<string, unknown>) {
  const config = hostedConfig('')
  config.oidc.metadata.issuer = 'https://accounts.google.com'
  config.oidc.metadata.authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
  config.oidc.metadata.tokenEndpoint = 'https://oauth2.googleapis.com/token'
  config.oidc.metadata.jwksUri = 'https://www.googleapis.com/oauth2/v3/certs'
  config.oidc.allowedDomains = ['example.com']
  config.oidc.allowedHostedDomains = ['example.com']

  const broker = new OAuthBroker(config)
  const authorizationUrl = new URL(broker.buildAccountLoginRedirect())
  const nonce = authorizationUrl.searchParams.get('nonce') || ''
  const state = authorizationUrl.searchParams.get('state') || ''
  const idToken = signOidcIdToken(config, nonce, claims)

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === config.oidc.metadata.tokenEndpoint) {
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === config.oidc.metadata.jwksUri) {
      return new Response(JSON.stringify({ keys: [oidcPublicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }))

  const result = await broker.completeOidcCallback(new URL(
    `http://localhost:3000/oauth/callback?${new URLSearchParams({ state, code: 'google-code' })}`,
  ))
  return { result, authorizationUrl }
}

function signOidcIdToken(config: HostedConfig, nonce: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: oidcKeyId,
  }
  const payload = {
    iss: config.oidc.metadata.issuer,
    aud: config.oidc.clientId,
    sub: 'google-user-1',
    iat: now,
    exp: now + 60,
    nonce,
    ...claims,
  }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(oidcKeys.privateKey)
  return `${signingInput}.${base64UrlEncode(signature)}`
}
