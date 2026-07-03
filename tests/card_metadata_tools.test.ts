import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleAddCardTags } from '../src/handlers/add_card_tags.js'
import { handleAddFileAttachment } from '../src/handlers/add_file_attachment.js'
import type { TpClient } from '../src/tp.js'

const mockTp = {
  addCardTags: vi.fn(),
  addAttachedFile: vi.fn(),
} as unknown as TpClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleAddCardTags', () => {
  it('adds labels through the client and returns response data', async () => {
    vi.mocked(mockTp.addCardTags).mockResolvedValue({
      ok: true,
      data: { Id: 67260, Tags: 'LLM-assisted, Model: Codex GPT-5' },
    } as any)

    const result = await handleAddCardTags(mockTp, {
      id: '67260',
      labels: ['LLM-assisted', 'Model: Codex GPT-5'],
      nativeType: 'Epic',
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Tags).toContain('LLM-assisted')
    expect(mockTp.addCardTags).toHaveBeenCalledWith({
      cardId: '67260',
      labels: ['LLM-assisted', 'Model: Codex GPT-5'],
      nativeType: 'Epic',
    })
  })

  it('returns confirmation when Targetprocess returns an empty successful response', async () => {
    vi.mocked(mockTp.addCardTags).mockResolvedValue({ ok: true, data: null } as any)

    const result = await handleAddCardTags(mockTp, { id: '67260', labels: ['LLM-assisted'] })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.updated).toBe(true)
    expect(parsed.cardId).toBe('67260')
    expect(parsed.labels).toEqual(['LLM-assisted'])
  })

  it('rejects empty labels before calling the client', async () => {
    const result = await handleAddCardTags(mockTp, { id: '67260', labels: ['  '] })

    expect(result.content[0].text).toContain('At least one non-empty label is required')
    expect(mockTp.addCardTags).not.toHaveBeenCalled()
  })

  it('surfaces Targetprocess failures', async () => {
    vi.mocked(mockTp.addCardTags).mockResolvedValue({
      ok: false,
      status: 400,
      body: 'Cannot update Tags',
    } as any)

    const result = await handleAddCardTags(mockTp, { id: '67260', labels: ['LLM-assisted'] })

    expect(result.content[0].text).toContain('Failed to add labels')
    expect(result.content[0].text).toContain('HTTP status: 400')
    expect(result.content[0].text).toContain('Cannot update Tags')
  })
})

describe('handleAddFileAttachment', () => {
  it('attaches a file through the client', async () => {
    vi.mocked(mockTp.addAttachedFile).mockResolvedValue('uploaded')

    const result = await handleAddFileAttachment(mockTp, {
      id: '67260',
      fileName: 'transcript.txt',
      fileContentBase64: 'aGVsbG8=',
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.attached).toBe(true)
    expect(parsed.fileName).toBe('transcript.txt')
    expect(mockTp.addAttachedFile).toHaveBeenCalledWith('67260', {
      fileName: 'transcript.txt',
      fileContent: 'aGVsbG8=',
    })
  })

  it('returns failure when upload fails', async () => {
    vi.mocked(mockTp.addAttachedFile).mockResolvedValue(null)

    const result = await handleAddFileAttachment(mockTp, {
      id: '67260',
      fileName: 'transcript.txt',
      fileContentBase64: 'aGVsbG8=',
    })

    expect(result.content[0].text).toContain('Failed to attach file')
    expect(result.content[0].text).toContain('67260')
  })
})
