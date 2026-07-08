import { afterEach, describe, expect, it, vi } from 'vitest'

const key = Buffer.alloc(32, 1).toString('base64')

describe('hosted MCP config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('loads OAuth client allowlist and endpoint metadata from env', async () => {
    vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
    const { loadHostedConfig, metadataPathForResource } = await import('../src/hosted/config.js')

    const config = await loadHostedConfig({
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      MCP_SIGNING_KEY_B64: key,
      TP_TOKEN_ENCRYPTION_KEY_B64: key,
      TP_TOKEN_STORE_PATH: '/var/lib/tp-mcp/tokens.json',
      MCP_OAUTH_STATE_STORE_PATH: '/var/lib/tp-mcp/oauth-state.json',
      MCP_METRICS_BEARER_TOKEN: 'metrics-token',
      MCP_TRUST_PROXY_HEADERS: '1',
      TP_SHARED_TOKEN: 'shared-token',
      MCP_OAUTH_CLIENTS_JSON: JSON.stringify([{
        client_id: 'claude-org',
        name: 'Claude org connector',
        redirect_uris: ['https://claude.ai/api/mcp/auth/callback'],
        allowed_origins: ['https://claude.ai'],
      }]),
      OIDC_ISSUER_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'oidc-client',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/authorize',
      OIDC_TOKEN_ENDPOINT: 'https://idp.example.com/token',
      OIDC_JWKS_URI: 'https://idp.example.com/jwks',
    } as NodeJS.ProcessEnv)

    expect(config.mcpUrl).toBe('https://mcp.example.com/mcp')
    expect(config.metricsPath).toBe('/metrics')
    expect(config.metricsBearerToken).toBe('metrics-token')
    expect(config.trustProxyHeaders).toBe(true)
    expect(config.resource).toBe('https://mcp.example.com/mcp')
    expect(config.oauthClients.get('claude-org')?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth/callback'])
    expect(config.oidc.metadata.tokenEndpoint).toBe('https://idp.example.com/token')
    expect(config.oidc.allowedDomains).toEqual([])
    expect(config.oidc.allowedHostedDomains).toEqual([])
    expect(config.tpPersonalAccessTokensUrl).toBe('https://example.tpondemand.com/RestUI/Board.aspx#page=settings/authAndSecurity/personalAccessTokensTab')
    expect(config.tokenStorePath).toBe('/var/lib/tp-mcp/tokens.json')
    expect(config.oauthStateStorePath).toBe('/var/lib/tp-mcp/oauth-state.json')
    expect(config.tpSharedToken).toBe('shared-token')
    expect(metadataPathForResource(config.resource)).toBe('/.well-known/oauth-protected-resource/mcp')
  })

  it('fails closed without an OAuth client allowlist', async () => {
    vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
    const { loadHostedConfig } = await import('../src/hosted/config.js')

    await expect(loadHostedConfig({
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      MCP_SIGNING_KEY_B64: key,
      TP_TOKEN_ENCRYPTION_KEY_B64: key,
      OIDC_ISSUER_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'oidc-client',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/authorize',
      OIDC_TOKEN_ENDPOINT: 'https://idp.example.com/token',
      OIDC_JWKS_URI: 'https://idp.example.com/jwks',
    } as NodeJS.ProcessEnv)).rejects.toThrow('MCP_OAUTH_CLIENTS_JSON')
  })

  it('requires OIDC configuration for hosted auth', async () => {
    vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
    const { loadHostedConfig } = await import('../src/hosted/config.js')

    await expect(loadHostedConfig({
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      MCP_SIGNING_KEY_B64: key,
      TP_TOKEN_ENCRYPTION_KEY_B64: key,
      MCP_OAUTH_CLIENTS_JSON: JSON.stringify([{
        client_id: 'claude-org',
        redirect_uris: ['https://claude.ai/api/mcp/auth/callback'],
      }]),
    } as NodeJS.ProcessEnv)).rejects.toThrow('OIDC_ISSUER_URL')
  })

  it('normalizes OIDC domain allowlists', async () => {
    vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
    const { loadHostedConfig } = await import('../src/hosted/config.js')

    const config = await loadHostedConfig({
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      MCP_SIGNING_KEY_B64: key,
      TP_TOKEN_ENCRYPTION_KEY_B64: key,
      MCP_OAUTH_CLIENTS_JSON: JSON.stringify([{
        client_id: 'claude-org',
        redirect_uris: ['https://claude.ai/api/mcp/auth/callback'],
      }]),
      OIDC_ISSUER_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'oidc-client',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/authorize',
      OIDC_TOKEN_ENDPOINT: 'https://idp.example.com/token',
      OIDC_JWKS_URI: 'https://idp.example.com/jwks',
      OIDC_ALLOWED_DOMAINS: 'Example.COM',
      OIDC_ALLOWED_HOSTED_DOMAINS: 'Example.COM',
    } as NodeJS.ProcessEnv)

    expect(config.oidc.allowedDomains).toEqual(['example.com'])
    expect(config.oidc.allowedHostedDomains).toEqual(['example.com'])
  })
})
