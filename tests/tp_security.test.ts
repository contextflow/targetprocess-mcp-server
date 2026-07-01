import { describe, expect, it } from 'vitest'
import {
  assertTargetprocessUrlAllowed,
  buildTpFetchInit,
  buildTargetprocessUrl,
  buildTpUrl,
  createTpDispatcher,
} from '../src/tp.js'

describe('Targetprocess URL security helpers', () => {
  it('builds API URLs with encoded path segments and query params', () => {
    const url = buildTpUrl('https://example.tpondemand.com', {
      pathParam: ['User Stories', '123/456'],
      param: {
        format: 'json',
        where: "Name eq 'hello world'",
      },
    })

    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://example.tpondemand.com')
    expect(parsed.pathname).toBe('/api/v1/User%20Stories/123%2F456/')
    expect(parsed.searchParams.get('format')).toBe('json')
    expect(parsed.searchParams.get('where')).toBe("Name eq 'hello world'")
  })

  it('builds non-API Targetprocess URLs on the same origin', () => {
    const url = buildTargetprocessUrl(
      'https://example.tpondemand.com',
      ['UploadFile.ashx'],
      { access_token: 'secret token' },
      { trailingSlash: false },
    )

    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://example.tpondemand.com')
    expect(parsed.pathname).toBe('/UploadFile.ashx')
    expect(parsed.searchParams.get('access_token')).toBe('secret token')
  })

  it('keeps API URL trailing slashes but preserves exact non-API paths when requested', () => {
    expect(new URL(buildTpUrl('https://example.tpondemand.com', {
      pathParam: ['Projects'],
      param: { format: 'json' },
    })).pathname).toBe('/api/v1/Projects/')

    expect(new URL(buildTargetprocessUrl(
      'https://example.tpondemand.com',
      ['UploadFile.ashx'],
      {},
      { trailingSlash: false },
    )).pathname).toBe('/UploadFile.ashx')
  })

  it('rejects non-HTTPS or non-default HTTPS base URLs', () => {
    expect(() =>
      buildTpUrl('http://example.tpondemand.com', { pathParam: ['Projects'], param: {} }),
    ).toThrow('https://')

    expect(() =>
      buildTpUrl('https://example.tpondemand.com:8443', { pathParam: ['Projects'], param: {} }),
    ).toThrow('default HTTPS port 443')
  })

  it('rejects outbound requests to a different origin', () => {
    expect(() =>
      assertTargetprocessUrlAllowed(
        'https://example.tpondemand.com',
        new URL('https://other.tpondemand.com/api/v1/Projects/'),
      ),
    ).toThrow('non-Targetprocess origin')
  })

  it('creates a proxy dispatcher only when a proxy socket is configured', () => {
    expect(createTpDispatcher('')).toBeUndefined()
    expect(createTpDispatcher('/tmp/tp-proxy.sock')).toBeDefined()
  })

  it('rejects redirects for Targetprocess requests', () => {
    expect(buildTpFetchInit({ method: 'GET' }).redirect).toBe('error')
    expect(buildTpFetchInit({ method: 'GET', redirect: 'follow' }).redirect).toBe('error')
  })
})
