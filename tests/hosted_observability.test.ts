import { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import { MetricsRegistry } from '../src/hosted/metrics.js'
import { defaultAccessPolicy } from '../src/hosted/policy.js'
import { sha256Base64Url } from '../src/hosted/security.js'
import type { AuditEvent } from '../src/hosted/audit.js'
import type { HostedConfig } from '../src/hosted/config.js'
import type { TargetprocessAccount, TargetprocessCredential, TargetprocessCredentialStore, TargetprocessUserSettings } from '../src/hosted/token_store.js'

const signingKey = Buffer.alloc(32, 9)

class MemoryCredentialStore implements TargetprocessCredentialStore {
  readonly accounts = new Map<string, TargetprocessAccount>()

  async getCredential(userId: string): Promise<TargetprocessCredential | null> {
    return this.accounts.get(userId)?.credential || null
  }

  async setCredential(userId: string, email: string, credential: TargetprocessCredential): Promise<void> {
    await this.setAccount(userId, email, {
      credential,
      accessMode: credential.kind === 'targetprocess_shared_token' ? 'shared' : 'personal',
      policy: defaultAccessPolicy,
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

function hostedConfig(overrides: Partial<HostedConfig> = {}): HostedConfig {
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
    tokenEncryptionKey: Buffer.alloc(32, 10),
    tokenStorePath: '/tmp/tokens.json',
    oauthStateStorePath: '',
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
    ...overrides,
  }
}

type ServerTestContext = {
  baseUrl: string
  events: AuditEvent[]
  oauth: OAuthBroker
  store: MemoryCredentialStore
  metrics: MetricsRegistry
}

async function withServer(config: HostedConfig, run: (context: ServerTestContext) => Promise<void>): Promise<void> {
  const { createHostedServer } = await import('../src/http.js')
  const oauth = new OAuthBroker(config)
  const store = new MemoryCredentialStore()
  const metrics = new MetricsRegistry()
  const events: AuditEvent[] = []
  const server = await createHostedServer({
    config,
    oauth,
    credentialStore: store,
    sessions: new Map(),
    metrics,
    auditLog: (event) => events.push(event),
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  config.publicUrl = baseUrl
  config.mcpUrl = `${baseUrl}${config.mcpPath}`
  config.oauthIssuer = baseUrl
  config.resource = config.mcpUrl
  try {
    await run({ baseUrl, events, oauth, store, metrics })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('hosted observability', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('protects metrics and records failed metrics authentication', async () => {
    await withServer(hostedConfig(), async ({ baseUrl, events }) => {
      const denied = await fetch(`${baseUrl}/metrics`)
      expect(denied.status).toBe(401)

      const allowed = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer metrics-token' },
      })
      const metrics = await allowed.text()

      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('content-type')).toContain('version=0.0.4')
      expect(metrics).toContain('targetprocess_mcp_http_requests_total')
      expect(metrics).toContain('targetprocess_mcp_security_failures_total')
      expect(events.some((event) => event.event === 'tp_mcp_security_failure' && event.reason === 'invalid_metrics_token')).toBe(true)
      expect(events.some((event) => event.event === 'tp_mcp_request_failure' && event.reason === 'invalid_metrics_token')).toBe(true)
    })
  })

  it('audits unauthenticated MCP calls and uses trusted proxy headers only when enabled', async () => {
    const config = hostedConfig({ trustProxyHeaders: true })
    await withServer(config, async ({ baseUrl, events }) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Length': '2',
          'X-Forwarded-For': '203.0.113.9, 10.0.0.2',
        },
        body: '{}',
      })

      expect(response.status).toBe(401)
      const failure = events.find((event) => event.event === 'tp_mcp_security_failure')
      expect(failure).toMatchObject({
        route: '/mcp',
        reason: 'invalid_token',
        clientIp: '203.0.113.9',
      })
      const requestFailure = events.find((event) => event.event === 'tp_mcp_request_failure')
      expect(requestFailure).toMatchObject({
        route: '/mcp',
        stage: 'auth',
        reason: 'invalid_token',
        status: 401,
        clientIp: '203.0.113.9',
      })
    })
  })

  it('records OAuth refresh token failures with grant type and client id', async () => {
    await withServer(hostedConfig(), async ({ baseUrl, events }) => {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'codex-local',
          refresh_token: 'stale-refresh-token',
        }),
      })

      expect(response.status).toBe(400)
      const failure = events.find((event) => event.event === 'tp_mcp_request_failure' && event.route === '/oauth/token')
      expect(failure).toMatchObject({
        stage: 'oauth',
        reason: 'invalid_grant',
        status: 400,
        grantType: 'refresh_token',
        clientId: 'codex-local',
      })
    })
  })

  it('ignores forwarded IP headers by default', async () => {
    await withServer(hostedConfig(), async ({ baseUrl, events }) => {
      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Length': '2',
          'X-Forwarded-For': '203.0.113.9',
        },
        body: '{}',
      })

      const failure = events.find((event) => event.event === 'tp_mcp_security_failure')
      expect(failure?.clientIp).not.toBe('203.0.113.9')
    })
  })

  it('records Targetprocess credential validation failures without leaking the submitted token', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === '127.0.0.1') return realFetch(url, init)
      return new Response(JSON.stringify({ error: 'invalid invalid-token access_token=invalid-token' }), { status: 401 })
    }))

    await withServer(hostedConfig(), async ({ baseUrl, events, oauth }) => {
      const session = oauth.createAccountSession({
        id: 'user-1',
        email: 'user@example.com',
        groups: [],
      })
      const page = await fetch(`${baseUrl}/account/targetprocess`, {
        headers: { Cookie: `__Host-tpmcp_account=${session}` },
      })
      const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
      expect(csrf).toBeTruthy()

      const response = await fetch(`${baseUrl}/account/targetprocess`, {
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
      expect(response.status).toBe(400)

      const failure = events.find((event) => event.event === 'tp_mcp_request_failure' && event.route === '/account/targetprocess')
      expect(failure).toMatchObject({
        stage: 'targetprocess_api',
        reason: 'targetprocess_credentials_invalid',
        targetprocessMethod: 'GET',
        targetprocessPath: '/api/v1/Context/',
        targetprocessStatus: 401,
        userId: 'user-1',
      })
      const serialized = JSON.stringify(failure)
      expect(serialized).not.toContain('invalid-token')
      expect(serialized).not.toContain('access_token=')
    })
  })

  it('records Targetprocess API failures from tool calls that return normal MCP results', async () => {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      if (parsed.hostname === '127.0.0.1') return realFetch(url, init)
      return new Response(JSON.stringify({ error: 'expired token tp-secret access_token=tp-secret' }), { status: 401 })
    }))

    await withServer(hostedConfig(), async ({ baseUrl, events, oauth, store }) => {
      await store.setAccount('user-1', 'user@example.com', {
        credential: { kind: 'targetprocess_access_token', token: 'tp-secret' },
        accessMode: 'personal',
        policy: defaultAccessPolicy,
      })
      const accessToken = issueAccessToken(oauth)
      const initialized = await mcpPost(baseUrl, accessToken, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hosted-observability-test', version: '0.0.0' },
        },
      })
      expect(initialized.body.result).toBeTruthy()
      expect(initialized.sessionId).toBeTruthy()

      await mcpPost(baseUrl, accessToken, initialized.sessionId, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      const toolResult = await mcpPost(baseUrl, accessToken, initialized.sessionId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_logged_in_user',
          arguments: {},
        },
      })

      expect(toolResult.body.result.content[0].text).toContain('Failed to get context')
      const failure = events.find((event) => event.event === 'tp_mcp_request_failure' && event.toolName === 'get_logged_in_user')
      expect(failure).toMatchObject({
        route: '/mcp',
        stage: 'targetprocess_api',
        reason: 'targetprocess_http_error',
        targetprocessMethod: 'GET',
        targetprocessPath: '/api/v1/Context/',
        targetprocessStatus: 401,
        targetprocessStatusClass: '4xx',
        userId: 'user-1',
        clientId: 'codex-local',
      })
      const toolAudit = events.find((event) => event.event === 'tool_call' && event.toolName === 'get_logged_in_user')
      expect(toolAudit).toMatchObject({ outcome: 'failure' })
      const serialized = JSON.stringify(failure)
      expect(serialized).not.toContain('tp-secret')
      expect(serialized).not.toContain('access_token=')
    })
  })
})

function issueAccessToken(oauth: OAuthBroker): string {
  const verifier = 'hosted-observability-verifier'
  const redirectUri = 'http://127.0.0.1/callback'
  const redirect = oauth.buildClientAuthorizationRedirect({
    user: { id: 'user-1', email: 'user@example.com', groups: [] },
    clientId: 'codex-local',
    redirectUri,
    scopes: ['mcp:tools'],
    codeChallenge: sha256Base64Url(verifier),
  })
  const code = new URL(redirect).searchParams.get('code') || ''
  const tokens = oauth.exchangeToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: 'codex-local',
    code_verifier: verifier,
  }))
  return String(tokens.access_token)
}

async function mcpPost(baseUrl: string, token: string, sessionId: string | undefined, body: unknown): Promise<{ sessionId?: string; body: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  expect(response.status).toBeLessThan(400)
  return {
    sessionId: response.headers.get('mcp-session-id') || undefined,
    body: parseMcpBody(await response.text()),
  }
}

function parseMcpBody(text: string): any {
  if (!text.trim()) return {}
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    return data ? JSON.parse(data) : {}
  }
  return JSON.parse(text)
}
