import { AddressInfo } from 'net'
import { describe, expect, it, vi } from 'vitest'
import { OAuthBroker } from '../src/hosted/oauth.js'
import { MetricsRegistry } from '../src/hosted/metrics.js'
import { defaultAccessPolicy } from '../src/hosted/policy.js'
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

async function withServer(config: HostedConfig, run: (baseUrl: string, events: AuditEvent[]) => Promise<void>): Promise<void> {
  const { createHostedServer } = await import('../src/http.js')
  const oauth = new OAuthBroker(config)
  const events: AuditEvent[] = []
  const server = await createHostedServer({
    config,
    oauth,
    credentialStore: new MemoryCredentialStore(),
    sessions: new Map(),
    metrics: new MetricsRegistry(),
    auditLog: (event) => events.push(event),
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  config.publicUrl = baseUrl
  config.mcpUrl = `${baseUrl}${config.mcpPath}`
  config.oauthIssuer = baseUrl
  config.resource = config.mcpUrl
  try {
    await run(baseUrl, events)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('hosted observability', () => {
  it('protects metrics and records failed metrics authentication', async () => {
    await withServer(hostedConfig(), async (baseUrl, events) => {
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
    })
  })

  it('audits unauthenticated MCP calls and uses trusted proxy headers only when enabled', async () => {
    const config = hostedConfig({ trustProxyHeaders: true })
    await withServer(config, async (baseUrl, events) => {
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
    })
  })

  it('ignores forwarded IP headers by default', async () => {
    await withServer(hostedConfig(), async (baseUrl, events) => {
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
})
