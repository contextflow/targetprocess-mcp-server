import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleGetProjects } from '../src/handlers/get_projects.js'
import type { TpClient } from '../src/tp.js'

const mockTp = {
  getProjects: vi.fn(),
  getLastRequestDiagnostic: vi.fn(),
} as unknown as TpClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleGetProjects', () => {
  it('returns mapped projects', async () => {
    vi.mocked(mockTp.getProjects).mockResolvedValue({
      Next: '',
      Items: [
        { Id: 1, Name: 'Project A' },
        { Id: 2, Name: 'Project B' },
      ] as any,
    })

    const result = await handleGetProjects(mockTp)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toEqual([
      { id: 1, name: 'Project A' },
      { id: 2, name: 'Project B' },
    ])
  })

  it('returns failure message when request returns null', async () => {
    vi.mocked(mockTp.getProjects).mockResolvedValue(null as any)

    const result = await handleGetProjects(mockTp)

    expect(result.content[0].text).toContain('Failed to get projects')
  })

  it('includes redacted request diagnostics when available', async () => {
    vi.mocked(mockTp.getProjects).mockResolvedValue(null as any)
    vi.mocked(mockTp.getLastRequestDiagnostic).mockReturnValue({
      method: 'GET',
      url: 'https://example.tpondemand.com/api/v1/Projects/?access_token=***',
      message: 'unable to get local issuer certificate',
    })

    const result = await handleGetProjects(mockTp)

    expect(result.content[0].text).toContain('unable to get local issuer certificate')
    expect(result.content[0].text).toContain('GET https://example.tpondemand.com/api/v1/Projects/?access_token=***')
  })

  it('returns not found message when Items is empty', async () => {
    vi.mocked(mockTp.getProjects).mockResolvedValue({ Next: '', Items: [] })

    const result = await handleGetProjects(mockTp)

    expect(result.content[0].text).toBe('No projects found')
  })
})
