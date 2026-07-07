import { describe, expect, it, vi } from 'vitest'
import { FrontdoorAuthError, FrontdoorClient, FrontdoorOpenTokenCache } from '../src/hosted/frontdoor.js'

describe('Frontdoor OpenToken client', () => {
  it('exchanges API keys for apptio-opentoken', async () => {
    const fetchFn = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'apptio-opentoken': 'open-token',
        valid_till: String(Math.floor(Date.now() / 1000) + 600),
      },
    })) as typeof fetch
    const client = new FrontdoorClient('https://frontdoor.example.com', fetchFn)

    const result = await client.login({
      kind: 'frontdoor_api_key',
      keyAccess: 'access',
      keySecret: 'secret',
    })

    expect(result.token).toBe('open-token')
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(fetchFn).toHaveBeenCalledWith('https://frontdoor.example.com/service/apikeylogin', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ keyAccess: 'access', keySecret: 'secret' }),
    }))
  })

  it('rejects missing OpenToken responses', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch
    const client = new FrontdoorClient('https://frontdoor.example.com', fetchFn)

    await expect(client.login({
      kind: 'frontdoor_api_key',
      keyAccess: 'access',
      keySecret: 'secret',
    })).rejects.toThrow(FrontdoorAuthError)
  })

  it('caches non-expired OpenTokens per user and credential', async () => {
    const fetchFn = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'apptio-opentoken': 'open-token',
        valid_till: String(Math.floor(Date.now() / 1000) + 600),
      },
    })) as typeof fetch
    const cache = new FrontdoorOpenTokenCache(new FrontdoorClient('https://frontdoor.example.com', fetchFn))
    const credential = {
      kind: 'frontdoor_api_key' as const,
      keyAccess: 'access',
      keySecret: 'secret',
    }

    expect(await cache.getOpenToken('user-1', credential)).toBe('open-token')
    expect(await cache.getOpenToken('user-1', credential)).toBe('open-token')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('exchanges browser login codes for apptio-opentoken', async () => {
    const fetchFn = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'apptio-opentoken': 'open-token',
        valid_till: String(Math.floor(Date.now() / 1000) + 600),
        renew_after: String(Math.floor(Date.now() / 1000) + 300),
        renew_till: String(Math.floor(Date.now() / 1000) + 3600),
      },
    })) as typeof fetch
    const client = new FrontdoorClient('https://frontdoor.example.com', fetchFn)

    const result = await client.exchangeCode('frontdoor-code')

    expect(result.token).toBe('open-token')
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(result.renewAfter).toBeGreaterThan(Date.now())
    expect(result.renewUntil).toBeGreaterThan(Date.now())
    expect(fetchFn).toHaveBeenCalledWith('https://frontdoor.example.com/exchangeCode', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ code: 'frontdoor-code' }),
    }))
  })

  it('renews OpenTokens through Frontdoor', async () => {
    const fetchFn = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'apptio-opentoken': 'renewed-token',
        valid_till: String(Math.floor(Date.now() / 1000) + 600),
      },
    })) as typeof fetch
    const client = new FrontdoorClient('https://frontdoor.example.com', fetchFn)

    const result = await client.renewToken('old-token')

    expect(result.token).toBe('renewed-token')
    expect(fetchFn).toHaveBeenCalledWith('https://frontdoor.example.com/service/renewtoken', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ 'apptio-opentoken': 'old-token' }),
    }))
  })
})
