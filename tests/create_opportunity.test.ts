import { describe, expect, it, vi } from 'vitest'
import { handleCreateOpportunity } from '../src/handlers/create_opportunity.js'
import type { TpClient } from '../src/tp.js'

const mockTp = {
  createEpic: vi.fn(),
  getLastRequestDiagnostic: vi.fn(),
} as unknown as TpClient

describe('handleCreateOpportunity', () => {
  it('creates an opportunity with a simple Epic payload', async () => {
    vi.mocked(mockTp.createEpic).mockResolvedValue({ Id: 67321, Name: 'Deploy MCP' } as any)

    const result = await handleCreateOpportunity(mockTp, {
      title: 'Deploy MCP',
      summary: 'Deploy the MCP for others.',
      what: 'Create a hosted deployment.',
      why: 'Reduce setup friction.',
      how: 'Use a secure NixOS container.',
      iceScore: 18,
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Id).toBe(67321)
    expect(mockTp.createEpic).toHaveBeenCalledWith({
      title: 'Deploy MCP',
      description: expect.stringContaining('<h3>Prioritization</h3>'),
      projectId: undefined,
      releaseId: undefined,
    })
  })
})
