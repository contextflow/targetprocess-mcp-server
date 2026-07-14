import { describe, expect, it, vi } from 'vitest'
import { TpClient } from '../src/tp.js'

class TestTpClient extends TpClient {
  readonly requests: Array<{ url: string; init: RequestInit }> = []
  private readonly responses: Response[]

  constructor(response: Response | Response[]) {
    super({
      baseUrl: 'https://example.tpondemand.com',
      auth: { kind: 'accessToken', token: 'secret-token' },
      projectId: '999',
      teamId: '888',
    })
    this.responses = Array.isArray(response) ? response : [response]
  }

  protected async fetch(url: string, init: RequestInit) {
    this.requests.push({ url, init })
    const response = this.responses.shift()
    if (!response) throw new Error('No test response configured')
    return response
  }
}

const input = {
  title: 'Bug creation preserves request fields',
  bugContent: '<div><h3>Issue Description</h3><p>Example bug details.</p></div>',
  origin: 'Developer Raised',
  projectId: '101',
  teamId: '202',
  entityStateId: '303',
}

describe('Targetprocess bug creation', () => {
  it('posts the complete native Bug payload and returns the created entity', async () => {
    const tp = new TestTpClient(new Response(JSON.stringify({ Id: 123, Name: input.title }), { status: 201 }))

    const result = await tp.createBugOnly(input)

    expect(result).toMatchObject({ Id: 123, Name: input.title })
    expect(new URL(tp.requests[0].url).pathname).toBe('/api/v1/bugs/')
    expect(JSON.parse(String(tp.requests[0].init.body))).toEqual({
      Name: input.title,
      Project: { Id: '101' },
      customFields: [{ name: 'Origin', type: 'DropDown', value: 'Developer Raised' }],
      assignedTeams: [{ team: { id: '202' } }],
      Description: input.bugContent,
      EntityState: { Id: '303' },
    })
  })

  it('records the HTTP status and redacted response body on rejection', async () => {
    const tp = new TestTpClient(new Response(
      '{"Message":"invalid secret-token access_token=secret-token"}',
      { status: 400 },
    ))

    const result = await tp.createBugOnly(input)

    expect(result).toBeNull()
    expect(tp.getLastRequestDiagnostic()).toMatchObject({
      method: 'POST',
      message: 'HTTP error! status: 400',
      status: 400,
    })
    expect(tp.getLastRequestDiagnostic()?.body).toContain('invalid *** access_token=***')
    expect(JSON.stringify(tp.getLastRequestDiagnostic())).not.toContain('secret-token')
  })

  it('retries without Origin when the project does not define that custom field', async () => {
    const tp = new TestTpClient([
      new Response(JSON.stringify({
        Status: 'BadRequest',
        Message: "There's no Origin custom field in this Project.",
      }), { status: 400 }),
      new Response(JSON.stringify({ Id: 124, Name: input.title }), { status: 201 }),
    ])

    const result = await tp.createBugOnly(input)

    expect(result).toMatchObject({ Id: 124 })
    expect(tp.requests).toHaveLength(2)
    expect(JSON.parse(String(tp.requests[0].init.body))).toHaveProperty('customFields')
    expect(JSON.parse(String(tp.requests[1].init.body))).not.toHaveProperty('customFields')
    expect(JSON.parse(String(tp.requests[1].init.body))).toMatchObject({
      Project: { Id: '101' },
      assignedTeams: [{ team: { id: '202' } }],
      EntityState: { Id: '303' },
    })
    expect(tp.getLastRequestDiagnostic()).toBeUndefined()
    expect(tp.getLastRequestWarning()).toContain('Origin "Developer Raised" was not applied')
  })

  it('records malformed successful responses before returning null', async () => {
    const tp = new TestTpClient(new Response('<html>not json</html>', { status: 200 }))

    const result = await tp.createBugOnly(input)

    expect(result).toBeNull()
    expect(tp.getLastRequestDiagnostic()).toMatchObject({
      status: 200,
      body: '<html>not json</html>',
    })
    expect(tp.getLastRequestDiagnostic()?.message).toContain('Failed to parse Targetprocess JSON response')
  })

  it.each([
    { body: '', message: 'Targetprocess returned an empty response body', diagnosticBody: '<empty>' },
    { body: 'null', message: 'Targetprocess returned JSON null', diagnosticBody: 'null' },
  ])('diagnoses a 2xx $diagnosticBody response', async ({ body, message, diagnosticBody }) => {
    const tp = new TestTpClient(new Response(body, { status: 200 }))

    const result = await tp.createBugOnly(input)

    expect(result).toBeNull()
    expect(tp.getLastRequestDiagnostic()).toMatchObject({
      message,
      status: 200,
      body: diagnosticBody,
    })
  })

  it('debug-logs the response status and a redacted body before parsing', async () => {
    vi.stubEnv('TP_DEBUG_HTTP', '1')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const tp = new TestTpClient(new Response('{"Message":"secret-token"}', { status: 400 }))
      await tp.createBugOnly(input)

      expect(error.mock.calls.some(([entry]) => String(entry).includes('TP_POST_RESPONSE'))).toBe(true)
      expect(error.mock.calls.map(([entry]) => String(entry)).join('\n')).not.toContain('secret-token')
    } finally {
      error.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
