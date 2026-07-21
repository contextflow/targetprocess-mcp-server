import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleGetTaskComments } from '../src/handlers/get_task_comments.js'
import { handleGetTaskContent } from '../src/handlers/get_task_content.js'
import { handleGetUserStoryTasks } from '../src/handlers/get_user_story_tasks.js'
import { TpClient } from '../src/tp.js'

const task = {
  ResourceType: 'Task',
  Id: 23456,
  Name: 'Review implementation',
  Description: '<p>Review the changes</p>',
  CreateDate: '2026-01-01',
  ModifyDate: '2026-01-02',
  EntityState: { Id: 3, Name: 'In Progress' },
  Project: { Id: 10, Name: 'Example project' },
  Team: { Id: 20, Name: 'Example team' },
  ResponsibleTeam: {
    Id: 30,
    Team: { Id: 20, Name: 'Example team' },
    EntityState: { Id: 4, Name: 'Doing' },
  },
  AssignedUser: { Id: 40, FullName: 'Example User' },
  Effort: 5,
  EffortCompleted: 2,
  EffortToDo: 3,
  TimeSpent: 1.5,
  TimeRemain: 2,
  UserStory: { Id: 12345, Name: 'Parent story', Feature: null },
} as any

const mockTp = {
  getUserStoryTasks: vi.fn(),
  getTask: vi.fn(),
  getTaskComments: vi.fn(),
  getBaseUrl: vi.fn(() => 'https://example.tpondemand.com'),
} as unknown as TpClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleGetUserStoryTasks', () => {
  it('returns normalized child tasks with assignments, estimates, and URLs', async () => {
    vi.mocked(mockTp.getUserStoryTasks).mockResolvedValue({
      Items: [task],
      Next: '/api/v1/UserStories/12345/Tasks/?skip=1',
    } as any)

    const result = await handleGetUserStoryTasks(mockTp, '12345', 10)
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.getUserStoryTasks).toHaveBeenCalledWith('12345', 10)
    expect(parsed.pagination).toEqual({ count: 1, limit: 10, hasMore: true })
    expect(parsed.items[0]).toMatchObject({
      id: 23456,
      state: { id: 3, name: 'In Progress' },
      assignedUser: { id: 40, fullName: 'Example User' },
      estimate: { effort: 5, completed: 2, remaining: 3 },
      url: 'https://example.tpondemand.com/entity/23456',
    })
  })

  it('returns an empty paginated result when the story has no tasks', async () => {
    vi.mocked(mockTp.getUserStoryTasks).mockResolvedValue({ Items: [], Next: '' } as any)

    const result = await handleGetUserStoryTasks(mockTp, '12345')

    expect(JSON.parse(result.content[0].text)).toEqual({
      items: [], pagination: { count: 0, limit: 100, hasMore: false },
    })
  })
})

describe('handleGetTaskContent', () => {
  it('returns task metadata and a linked parent story URL', async () => {
    vi.mocked(mockTp.getTask).mockResolvedValue(task)

    const result = await handleGetTaskContent(mockTp, '23456')
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.description).toContain('Review the changes')
    expect(parsed.userStory).toEqual({
      id: 12345,
      name: 'Parent story',
      url: 'https://example.tpondemand.com/entity/12345',
    })
    expect(parsed.responsibleTeam.state.name).toBe('Doing')
  })

  it('returns a failure message when the task cannot be read', async () => {
    vi.mocked(mockTp.getTask).mockResolvedValue(null as any)

    const result = await handleGetTaskContent(mockTp, '23456')

    expect(result.content[0].text).toContain('Failed to get task, id: 23456')
  })
})

describe('handleGetTaskComments', () => {
  it('preserves rich HTML and returns plain text plus pagination', async () => {
    vi.mocked(mockTp.getTaskComments).mockResolvedValue({
      Items: [{
        Id: 50,
        Description: '<p>Review <strong>this</strong></p>',
        CreateDate: '2026-01-03',
        Owner: { Id: 40, FullName: 'Example User' },
      }],
      Next: '/api/v1/Tasks/23456/Comments/?skip=1',
    } as any)

    const result = await handleGetTaskComments(mockTp, '23456', 5)
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.getTaskComments).toHaveBeenCalledWith('23456', 5)
    expect(parsed.pagination).toEqual({ count: 1, limit: 5, hasMore: true })
    expect(parsed.items[0]).toEqual({
      id: 50,
      author: { id: 40, fullName: 'Example User' },
      createDate: '2026-01-03',
      description: '<p>Review <strong>this</strong></p>',
      text: 'Review this',
    })
  })

  it('returns an empty paginated result when the task has no comments', async () => {
    vi.mocked(mockTp.getTaskComments).mockResolvedValue({ Items: [], Next: '' } as any)

    const result = await handleGetTaskComments(mockTp, '23456')

    expect(JSON.parse(result.content[0].text)).toEqual({
      items: [], pagination: { count: 0, limit: 25, hasMore: false },
    })
  })
})

describe('TpClient task reads', () => {
  it('uses the native nested task and comment collections', async () => {
    class TestTpClient extends TpClient {
      readonly urls: string[] = []

      constructor() {
        super({
          baseUrl: 'https://example.tpondemand.com',
          auth: { kind: 'accessToken', token: 'secret-token' },
        })
      }

      protected async fetch(url: string) {
        this.urls.push(url)
        return new Response(JSON.stringify({ Items: [], Next: '' }), { status: 200 })
      }
    }

    const tp = new TestTpClient()
    await tp.getUserStoryTasks('12345', 10)
    await tp.getTask('23456')
    await tp.getTaskComments('23456', 5)

    expect(new URL(tp.urls[0]).pathname).toBe('/api/v1/UserStories/12345/Tasks/')
    expect(new URL(tp.urls[0]).searchParams.get('take')).toBe('10')
    expect(new URL(tp.urls[0]).searchParams.get('include')).toContain('AssignedUser')
    expect(new URL(tp.urls[1]).pathname).toBe('/api/v1/Tasks/23456/')
    expect(new URL(tp.urls[1]).searchParams.get('include')).toContain('UserStory')
    expect(new URL(tp.urls[2]).pathname).toBe('/api/v1/Tasks/23456/Comments/')
    expect(new URL(tp.urls[2]).searchParams.get('take')).toBe('5')
  })
})
