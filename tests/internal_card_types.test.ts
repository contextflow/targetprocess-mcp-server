import { describe, it, expect, vi, afterEach } from 'vitest'

const originalInternalCardTypesJson = process.env.TP_INTERNAL_CARD_TYPES_JSON

afterEach(() => {
  if (originalInternalCardTypesJson === undefined) {
    delete process.env.TP_INTERNAL_CARD_TYPES_JSON
  } else {
    process.env.TP_INTERNAL_CARD_TYPES_JSON = originalInternalCardTypesJson
  }
  vi.resetModules()
})

describe('internal card type registry', () => {
  it('maps default organization kinds to native Targetprocess types', async () => {
    delete process.env.TP_INTERNAL_CARD_TYPES_JSON
    vi.resetModules()

    const { resolveInternalCardType } = await import('../src/internal_card_types.js')

    expect(resolveInternalCardType('opportunity')?.nativeType).toBe('Epic')
    expect(resolveInternalCardType('PCR')?.nativeType).toBe('Request')
    expect(resolveInternalCardType('problem report ticket')?.kind).toBe('prt')
    expect(resolveInternalCardType('software story')?.nativeType).toBe('UserStory')
  })

  it('infers internal kinds from native type and title conventions', async () => {
    delete process.env.TP_INTERNAL_CARD_TYPES_JSON
    vi.resetModules()

    const { inferInternalCardKind } = await import('../src/internal_card_types.js')

    expect(inferInternalCardKind('Epic', { Name: 'Sectra Amplifier Integration' })).toBe('opportunity')
    expect(inferInternalCardKind('Feature', { Name: 'SSR_CI - Configuration item' })).toBe('ssr')
    expect(inferInternalCardKind('Feature', { Name: 'Implementation feature' })).toBeNull()
    expect(inferInternalCardKind('Request', { Name: 'CAPA root cause analysis' })).toBe('capa')
  })

  it('merges valid JSON overrides into defaults', async () => {
    process.env.TP_INTERNAL_CARD_TYPES_JSON = JSON.stringify({
      pcr: {
        nativeType: 'Feature',
        aliases: ['change request'],
        titlePrefixes: ['QCRT '],
      },
    })
    vi.resetModules()

    const { resolveInternalCardType, inferInternalCardKind } = await import('../src/internal_card_types.js')

    expect(resolveInternalCardType('change request')?.nativeType).toBe('Feature')
    expect(inferInternalCardKind('Feature', { Name: 'QCRT Update process' })).toBe('pcr')
  })

  it('rejects invalid JSON override native types', async () => {
    process.env.TP_INTERNAL_CARD_TYPES_JSON = JSON.stringify({
      pcr: { nativeType: 'Thing' },
    })
    vi.resetModules()

    const { getInternalCardTypes } = await import('../src/internal_card_types.js')

    expect(() => getInternalCardTypes()).toThrow('Invalid nativeType')
  })
})
