import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleCreateInternalCard,
  handleDeleteInternalCard,
  handleGetInternalCard,
  handleGetInternalCardTypes,
  handleSearchInternalCards,
} from '../src/handlers/internal_cards.js'
import type { TpClient } from '../src/tp.js'

const mockTp = {
  searchContainsNameText: vi.fn(),
  searchContainsDescriptionText: vi.fn(),
  getInternalCard: vi.fn(),
  createEpic: vi.fn(),
  createFeature: vi.fn(),
  createUserStory: vi.fn(),
  createBugOnly: vi.fn(),
  createRequest: vi.fn(),
  getTeams: vi.fn(),
  deleteCard: vi.fn(),
  getLastRequestDiagnostic: vi.fn(),
} as unknown as TpClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleGetInternalCardTypes', () => {
  it('returns default internal card mappings', async () => {
    const result = await handleGetInternalCardTypes()
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toContainEqual(expect.objectContaining({
      kind: 'pcr',
      nativeType: 'Request',
      collection: 'Requests',
    }))
    expect(parsed).toContainEqual(expect.objectContaining({
      kind: 'ssr',
      nativeType: 'Feature',
      collection: 'Features',
    }))
  })
})

describe('handleSearchInternalCards', () => {
  it('searches the native collection for the requested internal kind', async () => {
    vi.mocked(mockTp.searchContainsNameText).mockResolvedValue({
      Items: [{ Id: 10, Name: 'Resolve: PDF report issue', Description: '<div>Why</div>' }],
    } as any)
    vi.mocked(mockTp.searchContainsDescriptionText).mockResolvedValue({ Items: [] } as any)

    const result = await handleSearchInternalCards(mockTp, { keyword: 'PDF', kind: 'PCR' })
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.searchContainsNameText).toHaveBeenCalledWith({
      text: 'PDF',
      entityType: 'Requests',
      take: 25,
    })
    expect(parsed[0]).toMatchObject({
      kind: 'pcr',
      nativeType: 'Request',
      collection: 'Requests',
      addCommentSupported: true,
      id: 10,
      name: 'Resolve: PDF report issue',
      description: 'Why',
    })
  })

  it('falls back from full phrase searches to meaningful terms', async () => {
    vi.mocked(mockTp.searchContainsNameText).mockResolvedValue({ Items: [] } as any)
    vi.mocked(mockTp.searchContainsDescriptionText).mockImplementation(async ({ text }) => ({
      Items: text === 'mcp'
        ? [{ Id: 67318, Name: 'Deploy and document the TargetProcess MCP for others', Description: '<div>TargetProcess MCP</div>' }]
        : [],
    }) as any)

    const result = await handleSearchInternalCards(mockTp, { keyword: 'target process mcp', kind: 'opportunity' })
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.searchContainsDescriptionText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'mcp',
      entityType: 'Epics',
    }))
    expect(parsed[0]).toMatchObject({
      id: 67318,
      nativeType: 'Epic',
      collection: 'Epics',
      addCommentSupported: true,
    })
  })

  it('returns an unknown-kind message without querying Targetprocess', async () => {
    const result = await handleSearchInternalCards(mockTp, { keyword: 'PDF', kind: 'not-real' })

    expect(result.content[0].text).toContain('Unknown internal card kind')
    expect(mockTp.searchContainsNameText).not.toHaveBeenCalled()
  })
})

describe('handleGetInternalCard', () => {
  it('fetches a card by mapped native type and returns normalized content', async () => {
    vi.mocked(mockTp.getInternalCard).mockResolvedValue({
      Id: 42,
      Name: 'SSR_CI - Configuration item',
      Description: '<div><h3>Requirement</h3><p>System MUST configure it.</p></div>',
      EntityState: { Name: 'Open' },
      Project: { Id: 1, Name: 'Product' },
      CustomFields: [],
    } as any)

    const result = await handleGetInternalCard(mockTp, { id: '42', kind: 'SSR' })
    const parsed = JSON.parse(result.content[0].text)

    expect(mockTp.getInternalCard).toHaveBeenCalledWith('Feature', '42')
    expect(parsed).toMatchObject({
      kind: 'ssr',
      label: 'SSR',
      nativeType: 'Feature',
      entityState: 'Open',
      project: 'Product',
    })
    expect(parsed.description).toContain('System MUST configure it.')
  })
})

describe('handleCreateInternalCard', () => {
  it('creates opportunities as Epics without fragile team or custom field payloads', async () => {
    vi.mocked(mockTp.createEpic).mockResolvedValue({ Id: 67265, Name: 'Support ARM in the product' } as any)

    const customFields = [
      { name: 'Expected Outcome', type: 'Text', value: 'ARM support is available' },
      { name: 'ICE', type: 'Number', value: 8 },
    ]

    const result = await handleCreateInternalCard(mockTp, {
      kind: 'opportunity',
      title: 'Support ARM in the product',
      projectId: '26420',
      teamId: 'DevOps',
      customFields,
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Id).toBe(67265)
    expect(mockTp.createEpic).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Support ARM in the product',
      projectId: '26420',
    }))
    expect(mockTp.getTeams).not.toHaveBeenCalled()
  })

  it('resolves team names before creating assignable non-Epic cards', async () => {
    vi.mocked(mockTp.getTeams).mockResolvedValue({
      Next: '',
      Items: [{ Id: 15987, Name: 'DevOps' }],
    } as any)
    vi.mocked(mockTp.createRequest).mockResolvedValue({ Id: 67266, Name: 'PCR: Deploy MCP' } as any)

    const result = await handleCreateInternalCard(mockTp, {
      kind: 'PCR',
      title: 'PCR: Deploy MCP',
      teamId: 'DevOps',
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Id).toBe(67266)
    expect(mockTp.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      teamId: '15987',
    }))
  })

  it('returns a useful error when a team name cannot be resolved for assignable non-Epic cards', async () => {
    vi.mocked(mockTp.getTeams).mockResolvedValue({
      Next: '',
      Items: [{ Id: 15987, Name: 'DevOps' }],
    } as any)

    const result = await handleCreateInternalCard(mockTp, {
      kind: 'PCR',
      title: 'PCR: Deploy MCP',
      teamId: 'Unknown Team',
    })

    expect(result.content[0].text).toContain('Could not resolve Targetprocess team "Unknown Team"')
    expect(mockTp.createRequest).not.toHaveBeenCalled()
  })

  it('creates PCRs as Targetprocess Requests with a structured HTML description', async () => {
    vi.mocked(mockTp.createRequest).mockResolvedValue({ Id: 100, Name: 'PCR: Add export' } as any)

    const result = await handleCreateInternalCard(mockTp, {
      kind: 'PCR',
      title: 'PCR: Add export',
      description: 'Implement export.',
      sections: {
        why: 'Customers need it.',
        affectedProduct: 'Example ADVANCE Chest CT',
      },
      projectId: '10',
      customFields: [{ name: 'Type', type: 'DropDown', value: 'Enabler' }],
    })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.Id).toBe(100)
    expect(mockTp.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      title: 'PCR: Add export',
      projectId: '10',
      customFields: [{ name: 'Type', type: 'DropDown', value: 'Enabler' }],
    }))
    const call = vi.mocked(mockTp.createRequest).mock.calls[0][0] as { description?: string }
    expect(call.description).toContain('<h3>Summary</h3>')
    expect(call.description).toContain('<h3>Why</h3>')
    expect(call.description).toContain('Customers need it.')
  })

  it('escapes section content when building template HTML', async () => {
    vi.mocked(mockTp.createFeature).mockResolvedValue({ Id: 200, Name: 'SSR_SEC - Escape' } as any)

    await handleCreateInternalCard(mockTp, {
      kind: 'SSR',
      title: 'SSR_SEC - Escape',
      sections: { requirement: '<script>alert(1)</script>' },
    })

    const call = vi.mocked(mockTp.createFeature).mock.calls[0][0] as { description?: string }
    expect(call.description).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(call.description).not.toContain('<script>alert(1)</script>')
  })
})

describe('handleDeleteInternalCard', () => {
  it('deletes opportunities through the native Epic collection', async () => {
    vi.mocked(mockTp.deleteCard).mockResolvedValue({
      ok: true,
      data: { Id: 67265 },
    } as any)

    const result = await handleDeleteInternalCard(mockTp, { id: '67265', kind: 'opportunity' })
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.deleted).toBe(true)
    expect(parsed.nativeType).toBe('Epic')
    expect(mockTp.deleteCard).toHaveBeenCalledWith({
      cardId: '67265',
      nativeType: 'Epic',
    })
  })

  it('surfaces Targetprocess delete failures', async () => {
    vi.mocked(mockTp.deleteCard).mockResolvedValue({
      ok: false,
      status: 404,
      body: 'Epic not found',
    } as any)

    const result = await handleDeleteInternalCard(mockTp, { id: '67265', kind: 'opportunity' })

    expect(result.content[0].text).toContain('Failed to delete Opportunity (Epic) id: 67265')
    expect(result.content[0].text).toContain('HTTP status: 404')
    expect(result.content[0].text).toContain('Epic not found')
  })
})
