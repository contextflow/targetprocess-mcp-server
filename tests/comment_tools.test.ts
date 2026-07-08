import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleAddComment, handleCanComment } from '../src/handlers/add_comment.js'
import { handleGetUserStoryComments } from '../src/handlers/get_user_story_comments.js'
import { handleGetBugComments } from '../src/handlers/get_bug_comments.js'
import { TpClient } from '../src/tp.js'

const mockTp = {
  addComment: vi.fn(),
  getGeneral: vi.fn(),
  getLastRequestDiagnostic: vi.fn(),
  getUserStoryComments: vi.fn(),
  getBugComments: vi.fn(),
} as unknown as TpClient

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handleAddComment', () => {
  it('returns comment response on success', async () => {
    const mockComment = { Id: 1, Description: 'Test comment', Owner: { FullName: 'Jane Doe' } }
    vi.mocked(mockTp.addComment).mockResolvedValue({ ok: true, data: mockComment } as any)

    const result = await handleAddComment(mockTp, '145789', 'Test comment')
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Id).toBe(1)
  })

  it('returns confirmation when Targetprocess returns an empty successful response', async () => {
    vi.mocked(mockTp.addComment).mockResolvedValue({ ok: true, data: null } as any)

    const result = await handleAddComment(mockTp, '145789', 'Test comment')
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.added).toBe(true)
    expect(parsed.cardId).toBe('145789')
  })

  it('surfaces HTTP status and response body on failure', async () => {
    vi.mocked(mockTp.addComment).mockResolvedValue({
      ok: false,
      status: 400,
      body: '{"Message":"Invalid General"}',
    } as any)

    const result = await handleAddComment(mockTp, '145789', 'Test comment')

    expect(result.content[0].text).toContain('Failed to add comment')
    expect(result.content[0].text).toContain('HTTP status: 400')
    expect(result.content[0].text).toContain('Invalid General')
    expect(result.content[0].text).toContain('145789')
  })

  it('surfaces attempted request diagnostics on failure when available', async () => {
    vi.mocked(mockTp.addComment).mockResolvedValue({
      ok: false,
      status: 400,
      body: '{"Message":"Error during deserializing resource."}',
    } as any)
    vi.mocked(mockTp.getLastRequestDiagnostic).mockReturnValue({
      method: 'POST',
      url: 'https://example.tpondemand.com/api/v1/Comments/?format=json&access_token=***',
      message: 'HTTP error! status: 400',
      status: 400,
      body: '{"Description":"Test comment","General":{"Id":"145789"}}',
    })

    const result = await handleAddComment(mockTp, '145789', 'Test comment')

    expect(result.content[0].text).toContain('Request: POST https://example.tpondemand.com/api/v1/Comments/?format=json&access_token=***')
    expect(result.content[0].text).toContain('"General":{"Id":"145789"}')
  })

  it('calls addComment with the provided id and comment', async () => {
    vi.mocked(mockTp.addComment).mockResolvedValue({ ok: true, data: { Id: 1 } } as any)

    await handleAddComment(mockTp, '145789', 'my comment')

    expect(mockTp.addComment).toHaveBeenCalledWith('145789', 'my comment')
  })
})

describe('handleCanComment', () => {
  it('returns generic comment support metadata for a card', async () => {
    vi.mocked(mockTp.getGeneral).mockResolvedValue({
      Id: 67318,
      Name: 'Deploy and document the TargetProcess MCP for others',
      ResourceType: 'Epic',
    } as any)

    const result = await handleCanComment(mockTp, '67318')
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.getGeneral).toHaveBeenCalledWith('67318')
    expect(parsed).toMatchObject({
      id: 67318,
      nativeType: 'Epic',
      collection: 'Comments',
      addCommentSupported: true,
    })
  })
})

describe('TpClient comment payloads', () => {
  it('posts comments through the canonical Comments collection payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ Id: 5 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tp = new TpClient({
      baseUrl: 'https://example.tpondemand.com',
      auth: { kind: 'accessToken', token: 'tp-token' },
      ownerId: '113',
    })

    await tp.addComment('67318', 'Test comment')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/v1/Comments/')
    expect(String(url)).toContain('access_token=tp-token')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      Description: 'Test comment',
      General: { Id: '67318' },
      Owner: { Id: '113' },
    })
  })
})

describe('handleGetUserStoryComments', () => {
  it('returns comments with stripped HTML', async () => {
    vi.mocked(mockTp.getUserStoryComments).mockResolvedValue({
      Next: '',
      Items: [{
        Id: 5,
        Description: '<p>Good point</p>',
        CreateDate: '2024-01-01',
        Owner: { FullName: 'Jane Doe' },
      }] as any,
    })

    const result = await handleGetUserStoryComments(mockTp, '145789')
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed[0].id).toBe(5)
    expect(parsed[0].description).toContain('Good point')
    expect(parsed[0].description).not.toContain('<p>')
    expect(parsed[0].owner).toBe('Jane Doe')
  })

  it('returns failure when null', async () => {
    vi.mocked(mockTp.getUserStoryComments).mockResolvedValue(null as any)

    const result = await handleGetUserStoryComments(mockTp, '145789')

    expect(result.content[0].text).toContain('Failed to get comments for user story id: 145789')
  })

  it('returns not found when empty', async () => {
    vi.mocked(mockTp.getUserStoryComments).mockResolvedValue({ Next: '', Items: [] })

    const result = await handleGetUserStoryComments(mockTp, '145789')

    expect(result.content[0].text).toContain('No comments found for user story id: 145789')
  })
})

describe('handleGetBugComments', () => {
  it('returns comments with stripped HTML', async () => {
    vi.mocked(mockTp.getBugComments).mockResolvedValue({
      Next: '',
      Items: [{
        Id: 7,
        Description: '<b>Reproduced on v2</b>',
        CreateDate: '2024-02-01',
        Owner: { FullName: 'John Smith' },
      }] as any,
    })

    const result = await handleGetBugComments(mockTp, '100001')
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed[0].id).toBe(7)
    expect(parsed[0].description).toContain('Reproduced on v2')
    expect(parsed[0].description).not.toContain('<b>')
    expect(parsed[0].owner).toBe('John Smith')
  })

  it('returns failure when null', async () => {
    vi.mocked(mockTp.getBugComments).mockResolvedValue(null as any)

    const result = await handleGetBugComments(mockTp, '100001')

    expect(result.content[0].text).toContain('Failed to get comments for bug id: 100001')
  })

  it('returns not found when empty', async () => {
    vi.mocked(mockTp.getBugComments).mockResolvedValue({ Next: '', Items: [] })

    const result = await handleGetBugComments(mockTp, '100001')

    expect(result.content[0].text).toContain('No comments found for bug id: 100001')
  })
})
