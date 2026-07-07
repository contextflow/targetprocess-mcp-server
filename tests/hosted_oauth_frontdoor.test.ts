import { describe, expect, it } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import { sha256Base64Url } from '../src/hosted/security.js'
import type { HostedConfig } from '../src/hosted/config.js'

const signingKey = Buffer.alloc(32, 4)

function config(): HostedConfig {
  return {
    authProvider: 'frontdoor',
    port: 3000,
    publicUrl: 'https://mcp.example.com',
    mcpPath: '/mcp',
    mcpUrl: 'https://mcp.example.com/mcp',
    oauthIssuer: 'https://mcp.example.com',
    resource: 'https://mcp.example.com/mcp',
    allowedOrigins: [],
    requireHttps: true,
    signingKey,
    tokenEncryptionKey: Buffer.alloc(32, 5),
    tokenStorePath: '/tmp/tokens.json',
    tpBaseUrl: 'https://example.tpondemand.com',
    frontdoorUrl: 'https://frontdoor-eu.apptio.com',
    oauthClients: new Map([[
      'claude-org',
      {
        clientId: 'claude-org',
        name: 'Claude org',
        redirectUris: ['https://claude.ai/api/mcp/auth/callback'],
        allowedOrigins: ['https://claude.ai'],
        scopes: ['mcp:tools'],
      },
    ]]),
  }
}

describe('Frontdoor upstream OAuth broker', () => {
  it('redirects MCP authorization requests to Frontdoor login and completes callback', () => {
    const broker = new OAuthBroker(config())
    const verifier = 'frontdoor-test-verifier'
    const redirect = broker.buildAuthorizationRedirect(new URL(`https://mcp.example.com/oauth/authorize?response_type=code&client_id=claude-org&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth/callback')}&scope=mcp:tools&code_challenge=${sha256Base64Url(verifier)}&code_challenge_method=S256&state=client-state`))
    const frontdoorUrl = new URL(redirect)

    expect(frontdoorUrl.origin).toBe('https://frontdoor-eu.apptio.com')
    expect(frontdoorUrl.pathname).toBe('/login')
    const state = frontdoorUrl.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(new URL(frontdoorUrl.searchParams.get('redirect') || '').toString()).toBe(`https://mcp.example.com/frontdoor/callback?state=${state}`)

    const result = broker.completeFrontdoorCallback(new URL(`https://mcp.example.com/frontdoor/callback?state=${state}&code=frontdoor-code`), {
      id: 'tp:113',
      email: 'user@example.com',
      groups: [],
    })

    expect(result.kind).toBe('oauth')
    expect(new URL(result.redirectUri).origin).toBe('https://claude.ai')
    expect(new URL(result.redirectUri).searchParams.get('state')).toBe('client-state')
    expect(new URL(result.redirectUri).searchParams.get('code')).toBeTruthy()
  })
})
