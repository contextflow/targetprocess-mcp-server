import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { HostedConfig } from '../src/hosted/config.js'
import { OAuthBroker, type OAuthAuthorizationResume } from '../src/hosted/oauth.js'
import { sha256Base64Url } from '../src/hosted/security.js'

function hostedConfig(oauthStateStorePath: string): HostedConfig {
  return {
    port: 3000,
    publicUrl: 'http://localhost:3000',
    mcpPath: '/mcp',
    mcpUrl: 'http://localhost:3000/mcp',
    oauthIssuer: 'http://localhost:3000',
    resource: 'http://localhost:3000/mcp',
    allowedOrigins: [],
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
})
