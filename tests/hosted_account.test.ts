import { AddressInfo } from 'net'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import type { HostedConfig } from '../src/hosted/config.js'
import { defaultAccessPolicy } from '../src/hosted/policy.js'
import { sha256Base64Url } from '../src/hosted/security.js'
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
      expect(html).toContain('Targetprocess MCP account settings')
      expect(html).toContain('Personal token status<strong>saved')
      expect(html).toContain('Replace personal token')
      expect(html).toContain('name="allow_creates"')
      expect(html).toContain('Revoke personal token')
      expect(html).not.toContain('saved-secret-token')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('renders service-token settings with read-only agent permissions', async () => {
    const { createHostedServer } = await import('../src/http.js')
    const config = hostedConfig()
    config.tpSharedToken = 'shared-token'
    const oauth = new OAuthBroker(config)
    const store = new MemoryCredentialStore()
    const session = oauth.createAccountSession({
      id: 'user-1',
      email: 'user@example.com',
      groups: [],
    })
    await store.setAccount('user-1', 'user@example.com', {
      credential: { kind: 'targetprocess_shared_token' },
      accessMode: 'shared',
      policy: defaultAccessPolicy,
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
      expect(html).toContain('Current access mode<strong>Limited service access')
      expect(html).toContain('Service-token mode uses fixed server-side permissions')
      expect(html).not.toContain('name="allow_creates"')
      expect(html).not.toContain('name="allow_comments"')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('deregisters the account, revokes OAuth grants, closes sessions, and redirects to Google account selection', async () => {
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

    const verifier = 'codex-local-verifier'
    const redirectUri = 'http://127.0.0.1/callback'
    const callback = oauth.buildClientAuthorizationRedirect({
      user: { id: 'user-1', email: 'user@example.com', groups: [] },
      clientId: 'codex-local',
      redirectUri,
      scopes: ['mcp:tools'],
      codeChallenge: sha256Base64Url(verifier),
    })
    const code = new URL(callback).searchParams.get('code') || ''
    const tokens = oauth.exchangeToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: 'codex-local',
      code_verifier: verifier,
    }))
    const refreshToken = String(tokens.refresh_token)
    const closeSpy = vi.fn(async () => undefined)
    const runtime = {
      config,
      oauth,
      credentialStore: store,
      sessions: new Map([['session-1', {
        transport: { close: closeSpy },
        userId: 'user-1',
        clientId: 'codex-local',
      }]]),
      oauthResumes: new Map([['resume-1', {
        kind: 'oauth',
        user: { id: 'user-1', email: 'user@example.com', groups: [] },
        clientId: 'codex-local',
        redirectUri,
        scopes: ['mcp:tools'],
        codeChallenge: sha256Base64Url('resume-verifier'),
        expiresAt: Date.now() + 30 * 60 * 1000,
      }]]),
      oauthResumesLoaded: true,
    }
    const server = await createHostedServer(runtime as any)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    try {
      const page = await fetch(`${baseUrl}/account/targetprocess`, {
        headers: { Cookie: `__Host-tpmcp_account=${session}` },
      })
      const html = await page.text()
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
      expect(html).toContain('Deregister and sign out')
      expect(csrf).toBeTruthy()

      const deregistered = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: `__Host-tpmcp_account=${session}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          action: 'deregister',
        }),
      })
      const location = new URL(deregistered.headers.get('location') || '')

      expect(deregistered.status).toBe(302)
      expect(location.origin).toBe('https://idp.example.com')
      expect(location.searchParams.get('prompt')).toBe('select_account')
      expect(deregistered.headers.get('set-cookie')).toContain('__Host-tpmcp_account=;')
      expect(await store.getCredential('user-1')).toBeNull()
      expect(runtime.sessions.has('session-1')).toBe(false)
      expect(closeSpy).toHaveBeenCalledTimes(1)
      expect(runtime.oauthResumes.has('resume-1')).toBe(false)
      expect(() => oauth.exchangeToken(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'codex-local',
      }))).toThrow('invalid_grant')
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
      expect(html).toContain('Connect Targetprocess MCP')
      expect(html).toContain('Save a current Targetprocess personal access token')
      expect(html).toContain('Save token and continue')
      expect(csrf).toBeTruthy()
      expect(oauthResume).toBeTruthy()

      const rejected = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          action: 'save_personal_finish_oauth',
          credential_kind: 'targetprocess_access_token',
          token: 'invalid-token',
          oauth_resume: oauthResume || '',
        }),
      })
      const rejectedHtml = await rejected.text()
      const retryResume = rejectedHtml.match(/name="oauth_resume" value="([^"]+)"/)?.[1]

      expect(rejected.status).toBe(400)
      expect(rejectedHtml).toContain('Targetprocess rejected that token')
      expect(retryResume).toBe(oauthResume)
      expect(await store.getCredential('user-1')).toBeNull()
      expect(rejectedHtml).not.toContain('invalid-token')

      const saved = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf: csrf || '',
          action: 'save_personal_finish_oauth',
          credential_kind: 'targetprocess_access_token',
          token: 'valid-token',
          oauth_resume: oauthResume || '',
        }),
      })
      const finalLocation = saved.headers.get('location') || ''

      expect(saved.status).toBe(302)
      expect(finalLocation).toMatch(/^http:\/\/127\.0\.0\.1:46317\/callback\/random\?code=/)
      expect(finalLocation).toContain('state=client-state')
      expect(await store.getCredential('user-1')).toEqual({
        kind: 'targetprocess_access_token',
        token: 'valid-token',
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('tolerates duplicate OAuth finish submits for the same account resume', async () => {
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
    const config = hostedConfig()
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
      const page = await fetch(setupLocation, { headers: { Cookie: cookie } })
      const html = await page.text()
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
      const oauthResume = html.match(/name="oauth_resume" value="([^"]+)"/)?.[1]
      const body = new URLSearchParams({
        csrf: csrf || '',
        action: 'finish_shared_oauth',
        oauth_resume: oauthResume || '',
      })

      const first = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      const second = await fetch(`${baseUrl}/account/targetprocess`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })

      expect(first.status).toBe(302)
      expect(second.status).toBe(302)
      expect(first.headers.get('location') || '').toMatch(/^http:\/\/127\.0\.0\.1:46317\/callback\/random\?code=/)
      expect(second.headers.get('location') || '').toMatch(/^http:\/\/127\.0\.0\.1:46317\/callback\/random\?code=/)
      expect(second.headers.get('location')).not.toBe(first.headers.get('location'))
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
      expect(html).toContain('Connect Targetprocess MCP')
      expect(html).toContain('Limited service access')
      expect(html).toContain('Continue to Codex local')
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
          action: 'finish_shared_oauth',
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
