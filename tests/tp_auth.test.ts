import { describe, expect, it } from 'vitest'
import { TpClient, type TpClientOptions } from '../src/tp.js'

class AuthTestClient extends TpClient {
  readonly requests: Array<{ url: string; init: RequestInit }> = []

  constructor(options: TpClientOptions, private readonly response: Response = new Response(JSON.stringify({ LoggedUser: { Id: 1 } }), { status: 200 })) {
    super(options)
  }

  protected async fetch(url: string, init: RequestInit) {
    this.requests.push({ url, init })
    return this.response
  }
}

describe('Targetprocess auth modes', () => {
  it('uses access_token query auth by default', async () => {
    const tp = new AuthTestClient({
      baseUrl: 'https://example.tpondemand.com',
      token: 'tp-secret',
    })

    await tp.getContext()

    const request = tp.requests[0]
    const url = new URL(request.url)
    expect(url.searchParams.get('access_token')).toBe('tp-secret')
    expect((request.init.headers as Record<string, string>)['apptio-opentoken']).toBeUndefined()
  })

  it('uses apptio-opentoken header auth without query tokens', async () => {
    const tp = new AuthTestClient({
      baseUrl: 'https://example.tpondemand.com',
      auth: { kind: 'apptioOpenToken', token: 'open-secret' },
    })

    await tp.getContext()

    const request = tp.requests[0]
    const url = new URL(request.url)
    expect(url.searchParams.has('access_token')).toBe(false)
    expect((request.init.headers as Record<string, string>)['apptio-opentoken']).toBe('open-secret')
  })

  it('redacts auth secrets in diagnostics', async () => {
    const tp = new AuthTestClient({
      baseUrl: 'https://example.tpondemand.com',
      auth: { kind: 'apptioOpenToken', token: 'open-secret' },
    }, new Response('failed for open-secret and access_token=tp-secret', { status: 500 }))

    await tp.getContext()

    const diagnostic = tp.getLastRequestDiagnostic()
    expect(diagnostic?.body).toContain('***')
    expect(diagnostic?.body).not.toContain('open-secret')
    expect(diagnostic?.body).not.toContain('tp-secret')
  })
})
