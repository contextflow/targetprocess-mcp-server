import { AddressInfo } from 'net'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import type { HostedConfig } from '../src/hosted/config.js'
import { defaultAccessPolicy } from '../src/hosted/policy.js'
import type { TargetprocessAccount, TargetprocessCredential, TargetprocessCredentialStore, TargetprocessUserSettings } from '../src/hosted/token_store.js'

const signingKey = Buffer.alloc(32, 3)

class MemoryCredentialStore implements TargetprocessCredentialStore {
  readonly accounts = new Map<string, TargetprocessAccount>()

  async getCredential(userId: string): Promise<TargetprocessCredential | null> {
    return this.accounts.get(userId)?.credential || null
  }

  async setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void> {
    await this.setAccount(userId, email, {
      credential,
      accessMode: credential.kind === 'targetprocess_shared_token' ? 'shared' : 'personal',
      policy: this.accounts.get(userId)?.policy || defaultAccessPolicy,
    })
  }

  async getAccount(userId: string): Promise<TargetprocessAccount | null> {
    return this.accounts.get(userId) || null
  }

  async setAccount(userId: string, email: string, account: TargetprocessAccount): Promise<void> {
    this.accounts.set(userId, { ...account, email, updatedAt: new Date().toISOString() })
  }

  async setSettings(userId: string, email: string, settings: TargetprocessUserSettings): Promise<void> {
    const account = this.accounts.get(userId) || { credential: null, accessMode: settings.accessMode, policy: defaultAccessPolicy }
    await this.setAccount(userId, email, { ...account, ...settings })
  }

  async deleteCredential(userId: string): Promise<void> {
    this.accounts.delete(userId)
  }

  async hasCredential(userId: string): Promise<boolean> {
    return this.accounts.has(userId)
  }
}

function hostedConfig(): HostedConfig {
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
    signingKey,
    tokenEncryptionKey: Buffer.alloc(32, 4),
    tokenStorePath: '/tmp/tokens.json',
    oauthStateStorePath: '',
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
    ], [
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

describe('hosted Targetprocess account setup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
      expect(html).toContain('Personal token status: <strong>saved')
      expect(html).toContain('Revoke personal token')
      expect(html).not.toContain('saved-secret-token')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts Codex loopback OAuth callback paths with random ports', () => {
    const oauth = new OAuthBroker(hostedConfig())
    const redirect = oauth.buildAuthorizationRedirect(new URL(
      'http://localhost:3000/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: 'codex-local',
        state: 'client-state',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        redirect_uri: 'http://127.0.0.1:46317/callback/mI1cg9UJHVIt',
        scope: 'mcp:tools',
      }).toString(),
    ))

    expect(new URL(redirect).origin).toBe('https://idp.example.com')
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

  it('requires a currently valid Targetprocess token before completing an OAuth login', async () => {
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
    vi.spyOn(oauth, 'completeOidcCallback').mockResolvedValue({
      kind: 'oauth',
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri: 'http://127.0.0.1:46317/callback/random',
      scopes: ['mcp:tools'],
      clientState: 'client-state',
      codeChallenge: 'challenge',
    })
    const store = new MemoryCredentialStore()
    await store.setCredential('user-1', 'user@example.com', {
      kind: 'targetprocess_access_token',
      token: 'expired-token',
    })
    const server = await createHostedServer({ config, oauth, credentialStore: store, sessions: new Map() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    config.publicUrl = baseUrl
    config.oauthIssuer = baseUrl
    config.resource = `${baseUrl}/mcp`
    config.mcpUrl = `${baseUrl}/mcp`

    try {
      const callback = await fetch(`${baseUrl}/oauth/callback?code=oidc-code&state=oidc-state`, {
        redirect: 'manual',
      })
      const setupLocation = callback.headers.get('location') || ''
      const cookie = callback.headers.get('set-cookie')?.split(';')[0] || ''

      expect(callback.status).toBe(302)
      expect(setupLocation).toContain('/account/targetprocess?')
      expect(setupLocation).toContain('oauth_resume=')
      expect(setupLocation).toContain('credential=invalid')
      expect(await store.getCredential('user-1')).toBeNull()

      const page = await fetch(setupLocation, { headers: { Cookie: cookie } })
      const html = await page.text()
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
      const oauthResume = html.match(/name="oauth_resume" value="([^"]+)"/)?.[1]
      expect(html).toContain('Review your Targetprocess MCP configuration')
      expect(html).toContain('Personal token status: <strong>not saved')
      expect(csrf).toBeTruthy()
      expect(oauthResume).toBeTruthy()

      const saved = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          credential_kind: 'targetprocess_access_token',
          token: 'valid-token',
          oauth_resume: oauthResume || '',
        }),
      })
      const savedHtml = await saved.text()
      const finishCsrf = savedHtml.match(/name="csrf" value="([^"]+)"/)?.[1]
      const finishResume = savedHtml.match(/name="oauth_resume" value="([^"]+)"/)?.[1]

      expect(saved.status).toBe(200)
      expect(savedHtml).toContain('Targetprocess credential saved. Review your configuration')
      expect(savedHtml).toContain('Finish MCP login')
      expect(finishCsrf).toBeTruthy()
      expect(finishResume).toBe(oauthResume)
      expect(await store.getCredential('user-1')).toEqual({
        kind: 'targetprocess_access_token',
        token: 'valid-token',
      })

      const finished = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: finishCsrf || '',
          action: 'finish_oauth',
          oauth_resume: finishResume || '',
        }),
      })
      const finalLocation = finished.headers.get('location') || ''

      expect(finished.status).toBe(302)
      expect(finalLocation).toMatch(/^http:\/\/127\.0\.0\.1:46317\/callback\/random\?code=/)
      expect(finalLocation).toContain('state=client-state')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps the OAuth review resume usable across a server restart', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === '127.0.0.1') return realFetch(url, init)
      const token = parsed.searchParams.get('access_token')
      if (token === 'shared-token') {
        return new Response(JSON.stringify({ LoggedUser: { Id: 113 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })
    }))

    const { createHostedServer } = await import('../src/http.js')
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-account-resume-'))
    const config = hostedConfig()
    config.oauthStateStorePath = join(dir, 'oauth-state.json')
    config.tpSharedToken = 'shared-token'
    const oauth = new OAuthBroker(config)
    vi.spyOn(oauth, 'completeOidcCallback').mockResolvedValue({
      kind: 'oauth',
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri: 'http://127.0.0.1:46317/callback/random',
      scopes: ['mcp:tools'],
      clientState: 'client-state',
      codeChallenge: 'challenge',
    })
    const store = new MemoryCredentialStore()
    const server = await createHostedServer({ config, oauth, credentialStore: store, sessions: new Map() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`
    config.publicUrl = baseUrl
    config.oauthIssuer = baseUrl
    config.resource = `${baseUrl}/mcp`
    config.mcpUrl = `${baseUrl}/mcp`

    let setupLocation = ''
    let cookie = ''
    try {
      const callback = await fetch(`${baseUrl}/oauth/callback?code=oidc-code&state=oidc-state`, {
        redirect: 'manual',
      })
      setupLocation = callback.headers.get('location') || ''
      cookie = callback.headers.get('set-cookie')?.split(';')[0] || ''

      expect(callback.status).toBe(302)
      expect(setupLocation).toContain('oauth_resume=')
      expect(await store.getCredential('user-1')).toEqual({ kind: 'targetprocess_shared_token' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const restarted = await createHostedServer({
      config,
      oauth: new OAuthBroker(config),
      credentialStore: store,
      sessions: new Map(),
    })
    await new Promise<void>((resolve) => restarted.listen(port, resolve))

    try {
      const page = await fetch(setupLocation, { headers: { Cookie: cookie } })
      const html = await page.text()
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
      const oauthResume = html.match(/name="oauth_resume" value="([^"]+)"/)?.[1]
      expect(html).toContain('Finish MCP login')
      expect(csrf).toBeTruthy()
      expect(oauthResume).toBeTruthy()

      const finished = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          action: 'finish_oauth',
          oauth_resume: oauthResume || '',
        }),
      })

      expect(finished.status).toBe(302)
      expect(finished.headers.get('location') || '').toMatch(/^http:\/\/127\.0\.0\.1:46317\/callback\/random\?code=/)
    } finally {
      await new Promise<void>((resolve) => restarted.close(() => resolve()))
    }
  })

  it('serves ChatGPT-compatible OAuth metadata and challenges', async () => {
    const { createHostedServer } = await import('../src/http.js')
    const config = hostedConfig()
    const oauth = new OAuthBroker(config)
    const store = new MemoryCredentialStore()
    const server = await createHostedServer({ config, oauth, credentialStore: store, sessions: new Map() })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    config.publicUrl = baseUrl
    config.oauthIssuer = baseUrl
    config.resource = `${baseUrl}/mcp`
    config.mcpUrl = `${baseUrl}/mcp`

    try {
      const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
      expect(metadata.status).toBe(200)
      await expect(metadata.json()).resolves.toMatchObject({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ['mcp:tools'],
      })

      const challenged = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '' })
      expect(challenged.status).toBe(401)
      expect(challenged.headers.get('www-authenticate')).toContain('scope="mcp:tools"')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts an empty unauthenticated MCP probe briefly after token exchange', async () => {
    const { createHostedServer } = await import('../src/http.js')
    const config = hostedConfig()
    const oauth = new OAuthBroker(config)
    const store = new MemoryCredentialStore()
    const runtime = {
      config,
      oauth,
      credentialStore: store,
      sessions: new Map(),
      allowEmptyUnauthenticatedMcpProbeUntil: Date.now() + 30_000,
    }
    const server = await createHostedServer(runtime)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    config.publicUrl = baseUrl
    config.oauthIssuer = baseUrl
    config.resource = `${baseUrl}/mcp`
    config.mcpUrl = `${baseUrl}/mcp`

    try {
      const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '' })
      expect(response.status).toBe(202)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
