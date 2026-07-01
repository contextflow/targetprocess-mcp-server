import { beforeEach, describe, expect, it, vi } from 'vitest'

async function createClient() {
  vi.resetModules()
  vi.stubEnv('TP_BASE_URL', 'https://example.tpondemand.com')
  vi.stubEnv('TP_TOKEN', 'secret-token')
  vi.stubEnv('TP_PROJECT_ID', '999')
  vi.stubEnv('TP_TEAM_ID', '888')

  const { TpClient } = await import('../src/tp.js')

  class TestTpClient extends TpClient {
    readonly urls: string[] = []
    readonly bodies: unknown[] = []

    protected async fetch(url: string, init: RequestInit) {
      this.urls.push(url)
      if (init.body) {
        this.bodies.push(JSON.parse(String(init.body)))
      }

      const path = new URL(url).pathname
      if (path === '/api/v2/userStory/') {
        return new Response(JSON.stringify({
          items: [{
            project: { id: 18544 },
            teamState: {
              id: 61204,
              team: { id: 6920, name: 'Software Development' },
              entityState: { id: 1, name: 'Submitted', workflowId: 277 },
            },
            teams: [{ teamAssignmentId: 61204, id: 6920, name: 'Software Development' }],
          }],
        }), { status: 200 })
      }

      if (path === '/api/v1/Tasks/') {
        return new Response(JSON.stringify({ Id: 123, Name: 'Write docs' }), { status: 200 })
      }

      return new Response('{}', { status: 404 })
    }
  }

  return new TestTpClient()
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('Targetprocess task creation', () => {
  it('inherits project and team from the linked user story', async () => {
    const tp = await createClient()

    const result = await tp.createTask({
      title: 'Write docs',
      userStoryId: '67248',
      description: 'Add instructions',
    })

    expect(result).toMatchObject({ Id: 123 })
    expect(tp.bodies[0]).toMatchObject({
      Name: 'Write docs',
      Description: 'Add instructions',
      Project: { Id: '18544' },
      UserStory: { Id: '67248' },
      assignedTeams: [{ team: { id: '6920' } }],
    })
  })
})
