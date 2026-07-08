import { beforeEach, describe, expect, it, vi } from 'vitest'

async function createClient(env: { projectId?: string; teamId?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
  vi.stubEnv('TP_TOKEN', 'secret-token')
  vi.stubEnv('TP_PROJECT_ID', env.projectId ?? '999')
  vi.stubEnv('TP_TEAM_ID', env.teamId ?? '888')

  const { TpClient } = await import('../src/tp.js')

  class TestTpClient extends TpClient {
    readonly bodies: unknown[] = []

    protected async fetch(url: string, init: RequestInit) {
      if (init.body) {
        this.bodies.push(JSON.parse(String(init.body)))
      }

      if (new URL(url).pathname === '/api/v1/UserStories/') {
        return new Response(JSON.stringify({ Id: 123, Name: 'Deploy MCP' }), { status: 200 })
      }

      return new Response('{}', { status: 404 })
    }
  }

  return new TestTpClient()
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('Targetprocess user story creation', () => {
  it('does not serialize empty fallback project or team IDs', async () => {
    const tp = await createClient({ projectId: '', teamId: '' })

    await tp.createUserStory({
      title: 'Deploy MCP',
      description: '<div>Deploy it.</div>',
    })

    expect(tp.bodies[0]).toEqual({
      Name: 'Deploy MCP',
      Description: '<div>Deploy it.</div>',
    })
  })

  it('serializes configured fallback project and team IDs when present', async () => {
    const tp = await createClient({ projectId: '26420', teamId: '15987' })

    await tp.createUserStory({
      title: 'Deploy MCP',
    })

    expect(tp.bodies[0]).toEqual({
      Name: 'Deploy MCP',
      Project: { Id: '26420' },
      assignedTeams: [{ team: { id: '15987' } }],
    })
  })
})
