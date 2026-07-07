import { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import type { HostedConfig } from '../src/hosted/config.js'
import type { TargetprocessCredential, TargetprocessCredentialStore } from '../src/hosted/token_store.js'

const signingKey = Buffer.alloc(32, 3)

class MemoryCredentialStore implements TargetprocessCredentialStore {
  readonly credentials = new Map<string, TargetprocessCredential>()

  async getCredential(userId: string): Promise<TargetprocessCredential | null> {
    return this.credentials.get(userId) || null
  }

  async setCredential(userId: string, _email: string, credential: TargetprocessCredential): Promise<void> {
    this.credentials.set(userId, credential)
  }

  async deleteCredential(userId: string): Promise<void> {
    this.credentials.delete(userId)
  }

  async hasCredential(userId: string): Promise<boolean> {
    return this.credentials.has(userId)
  }
}

function hostedConfig(): HostedConfig {
  return {
    port: 3000,
    publicUrl: 'http://localhost:3000',
    mcpPath: '/mcp',
    mcpUrl: 'http://localhost:3000/mcp',
    oauthIssuer: 'http://localhost:3000',
    resource: 'http://localhost:3000/mcp',
    allowedOrigins: [],
    requireHttps: false,
    signingKey,
    tokenEncryptionKey: Buffer.alloc(32, 4),
    tokenStorePath: '/tmp/tokens.json',
    tpBaseUrl: 'https://example.tpondemand.com',
    tpPersonalAccessTokensUrl: 'https://example.tpondemand.com/RestUI/Board.aspx#page=settings/authAndSecurity/personalAccessTokensTab',
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

describe('hosted Targetprocess account setup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the PAT setup link and never renders a saved token', async () => {
    const { createHostedServer } = await import('../src/http.js')
    const config = hostedConfig()
    const oauth = new OAuthBroker(config)
    const store = new MemoryCredentialStore()
    const session = oauth.createAccountSession({
      id: 'user-1',
      email: 'user@example.com',
      groups: [],
    })
    await store.setCredential('user-1', 'user@example.com', {
      kind: 'targetprocess_access_token',
      token: 'saved-secret-token',
    })
    const server = await createHostedServer({ config, oauth, credentialStore: store, sessions: new Map() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const response = await fetch(`${baseUrl}/account/targetprocess`, {
        headers: { Cookie: `__Host-tpmcp_account=${session}` },
      })
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('RestUI/Board.aspx#page=settings/authAndSecurity/personalAccessTokensTab')
      expect(html).toContain('Targetprocess credential status: <strong>saved')
      expect(html).toContain('Revoke token')
      expect(html).not.toContain('saved-secret-token')
      expect(html).not.toContain('Frontdoor')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('validates before saving and keeps the PAT link visible on invalid tokens', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === '127.0.0.1') return realFetch(url, init)
      const token = parsed.searchParams.get('access_token')
      if (token === 'valid-token') {
        return new Response(JSON.stringify({ LoggedUser: { Id: 113 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })
    }))

    const { createHostedServer } = await import('../src/http.js')
    const config = hostedConfig()
    const oauth = new OAuthBroker(config)
    const store = new MemoryCredentialStore()
    const session = oauth.createAccountSession({
      id: 'user-1',
      email: 'user@example.com',
      groups: [],
    })
    const server = await createHostedServer({ config, oauth, credentialStore: store, sessions: new Map() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const page = await fetch(`${baseUrl}/account/targetprocess`, {
        headers: { Cookie: `__Host-tpmcp_account=${session}` },
      })
      const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
      expect(csrf).toBeTruthy()

      const invalid = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-tpmcp_account=${session}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          credential_kind: 'targetprocess_access_token',
          token: 'invalid-token',
        }),
      })
      const invalidHtml = await invalid.text()

      expect(invalid.status).toBe(400)
      expect(await store.getCredential('user-1')).toBeNull()
      expect(invalidHtml).toContain('Targetprocess rejected that token')
      expect(invalidHtml).toContain('RestUI/Board.aspx#page=settings/authAndSecurity/personalAccessTokensTab')
      expect(invalidHtml).not.toContain('invalid-token')

      const valid = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-tpmcp_account=${session}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          credential_kind: 'targetprocess_access_token',
          token: 'valid-token',
        }),
      })
      const validHtml = await valid.text()

      expect(valid.status).toBe(200)
      expect(await store.getCredential('user-1')).toEqual({
        kind: 'targetprocess_access_token',
        token: 'valid-token',
      })
      expect(validHtml).toContain('Targetprocess credential saved.')
      expect(validHtml).not.toContain('valid-token')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
