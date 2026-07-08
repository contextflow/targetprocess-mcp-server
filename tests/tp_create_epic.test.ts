import { beforeEach, describe, expect, it, vi } from 'vitest'

async function createClient(env: { projectId?: string; teamId?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
  vi.stubEnv('TP_TOKEN', 'secret-token')
  vi.stubEnv('TP_PROJECT_ID', env.projectId ?? '999')
  vi.stubEnv('TP_TEAM_ID', env.teamId ?? '888')

  const { TpClient } = await import('../src/tp.js')

  class TestTpClient extends TpClient {
    readonly urls: string[] = []
    readonly bodies: unknown[] = []

    protected async fetch(url: string, init: RequestInit) {
      this.urls.push(url)
      if (init.body) {
        this.bodies.push(JSON.parse(String(init.body)))
      }

      if (new URL(url).pathname === '/api/v1/Epics/') {
        return new Response(JSON.stringify({ Id: 67265, Name: 'Support ARM in the product' }), { status: 200 })
      }

      return new Response('{}', { status: 404 })
    }
  }

  return new TestTpClient()
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('Targetprocess epic creation', () => {
  it('serializes the selected team assignment', async () => {
    const tp = await createClient()

    const result = await tp.createEpic({
      title: 'Support ARM in the product',
      description: '<p>Ship ARM support.</p>',
      projectId: '26420',
      teamId: '15987',
    })

    expect(result).toMatchObject({ Id: 67265 })
    expect(tp.bodies[0]).toMatchObject({
      Name: 'Support ARM in the product',
      Description: '<p>Ship ARM support.</p>',
      Project: { Id: '26420' },
      assignedTeams: [{ team: { id: '15987' } }],
    })
  })

  it('does not serialize empty fallback project or team IDs', async () => {
    const tp = await createClient({ projectId: '', teamId: '' })

    await tp.createEpic({
      title: 'Deploy MCP',
    })

    expect(tp.bodies[0]).toEqual({
      Name: 'Deploy MCP',
    })
  })

  it('does not serialize configured fallback team IDs for epics', async () => {
    const tp = await createClient({ projectId: '64980', teamId: '15987' })

    await tp.createEpic({
      title: 'Deploy MCP',
    })

    expect(tp.bodies[0]).toEqual({
      Name: 'Deploy MCP',
      Project: { Id: '64980' },
    })
  })
})
