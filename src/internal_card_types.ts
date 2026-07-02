import { config } from './config.js'
import type { TpNativeCardType } from './types.js'

export type InternalCardKind =
  | 'opportunity'
  | 'pcr'
  | 'prt'
  | 'capa'
  | 'ssr'
  | 'software_story'
  | 'bug'

export type InternalCardTemplateSection = {
  key: string
  label: string
}

export type InternalCardTypeDefinition = {
  kind: InternalCardKind
  label: string
  nativeType: TpNativeCardType
  aliases: string[]
  titlePrefixes?: string[]
  templateSections?: InternalCardTemplateSection[]
  description: string
}

type InternalCardTypeOverride = Partial<Omit<InternalCardTypeDefinition, 'kind'>>

export const INTERNAL_CARD_KIND_VALUES = [
  'opportunity',
  'pcr',
  'prt',
  'capa',
  'ssr',
  'software_story',
  'bug',
] as const

const DEFAULT_INTERNAL_CARD_TYPES: Record<InternalCardKind, InternalCardTypeDefinition> = {
  opportunity: {
    kind: 'opportunity',
    label: 'Opportunity',
    nativeType: 'Epic',
    aliases: ['opportunity', 'opportunities', 'epic', 'epics'],
    description: 'Strategic product opportunity tracked as a Targetprocess Epic.',
    templateSections: [
      { key: 'scope', label: 'Scope' },
      { key: 'expectedOutcome', label: 'Expected Outcome' },
      { key: 'availableProof', label: 'Available Proof' },
      { key: 'acceptanceCriteria', label: 'Acceptance Criteria' },
    ],
  },
  pcr: {
    kind: 'pcr',
    label: 'PCR',
    nativeType: 'Request',
    aliases: ['pcr', 'pcrs', 'product change request', 'product change requests'],
    titlePrefixes: ['PCR ', 'PCR:', 'Resolve:', 'Refine ', 'Update ', 'Mitigation:'],
    description: 'Product Change Request tracked as a Targetprocess Request.',
    templateSections: [
      { key: 'what', label: 'What' },
      { key: 'why', label: 'Why' },
      { key: 'how', label: 'How' },
      { key: 'affectedProduct', label: 'Affected product' },
      { key: 'affectedArtifacts', label: 'Affected documents / artifacts' },
      { key: 'productConfiguration', label: 'Product configuration' },
      { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
    ],
  },
  prt: {
    kind: 'prt',
    label: 'PRT',
    nativeType: 'Request',
    aliases: ['prt', 'prts', 'problem report ticket', 'problem report tickets'],
    titlePrefixes: ['PRT ', 'PRT:', 'Problem ', 'Bug report '],
    description: 'Problem Report Ticket tracked as a Targetprocess Request.',
    templateSections: [
      { key: 'problemDescription', label: 'Problem Description' },
      { key: 'runtimeEnvironment', label: 'Runtime environment' },
      { key: 'stepsToReproduce', label: 'Steps to reproduce the problem' },
      { key: 'causeAnalysis', label: 'Cause Analysis' },
      { key: 'actionPlan', label: 'Action Plan' },
      { key: 'verification', label: 'Verification' },
    ],
  },
  capa: {
    kind: 'capa',
    label: 'CAPA',
    nativeType: 'Request',
    aliases: ['capa', 'capas', 'corrective and preventive action', 'corrective and preventive actions'],
    titlePrefixes: ['CAPA ', 'CAPA:', 'Corrective Action ', 'Preventive Action '],
    description: 'Corrective and Preventive Action tracked as a Targetprocess Request.',
    templateSections: [
      { key: 'nonconformity', label: 'Nonconformity' },
      { key: 'riskAndRecurrence', label: 'Risk level and recurrence probability' },
      { key: 'rootCauseAnalysis', label: 'Root Cause Analysis' },
      { key: 'correctiveAction', label: 'Corrective Action' },
      { key: 'preventiveAction', label: 'Preventive Action' },
      { key: 'effectivenessCheck', label: 'Effectiveness Check' },
    ],
  },
  ssr: {
    kind: 'ssr',
    label: 'SSR',
    nativeType: 'Feature',
    aliases: ['ssr', 'ssrs', 'software system requirement', 'software system requirements'],
    titlePrefixes: ['SSR_', 'SSR-', 'SSR '],
    description: 'Software System Requirement tracked as a Targetprocess Feature.',
    templateSections: [
      { key: 'requirement', label: 'Requirement' },
      { key: 'detailedDescription', label: 'Detailed description' },
      { key: 'dynamicBehaviour', label: 'Dynamic behaviour' },
      { key: 'verificationNotes', label: 'Verification notes' },
    ],
  },
  software_story: {
    kind: 'software_story',
    label: 'Software User Story',
    nativeType: 'UserStory',
    aliases: ['software story', 'software stories', 'user story', 'user stories', 'story', 'stories'],
    description: 'Software implementation story tracked as a Targetprocess UserStory.',
  },
  bug: {
    kind: 'bug',
    label: 'Bug',
    nativeType: 'Bug',
    aliases: ['bug', 'bugs', 'defect', 'defects'],
    description: 'Software bug tracked as a Targetprocess Bug.',
  },
}

export function getDefaultInternalCardTypes(): Record<InternalCardKind, InternalCardTypeDefinition> {
  return cloneRegistry(DEFAULT_INTERNAL_CARD_TYPES)
}

export function getInternalCardTypes(): Record<InternalCardKind, InternalCardTypeDefinition> {
  const registry = getDefaultInternalCardTypes()
  if (!config.tp.internalCardTypesJson) return registry

  const parsed = parseInternalCardTypeOverrides(config.tp.internalCardTypesJson)
  for (const [kind, override] of Object.entries(parsed)) {
    assertInternalCardKind(kind)
    registry[kind] = {
      ...registry[kind],
      ...override,
      kind,
      aliases: override.aliases ?? registry[kind].aliases,
      templateSections: override.templateSections ?? registry[kind].templateSections,
      titlePrefixes: override.titlePrefixes ?? registry[kind].titlePrefixes,
    }
  }

  return registry
}

export function resolveInternalCardType(kindOrAlias: string): InternalCardTypeDefinition | null {
  const normalized = normalizeKindToken(kindOrAlias)
  const registry = getInternalCardTypes()

  for (const definition of Object.values(registry)) {
    if (definition.kind === normalized) return definition
    if (definition.aliases.some((alias) => normalizeKindToken(alias) === normalized)) return definition
  }

  return null
}

export function inferInternalCardKind(
  nativeType: TpNativeCardType,
  card: { Name?: string; name?: string },
): InternalCardKind | null {
  const name = card.Name ?? card.name ?? ''
  const registry = getInternalCardTypes()
  const candidates = Object.values(registry).filter((definition) => definition.nativeType === nativeType)

  for (const definition of candidates) {
    if (definition.titlePrefixes?.some((prefix) => name.toLowerCase().startsWith(prefix.toLowerCase()))) {
      return definition.kind
    }
  }

  if (candidates.length === 1 && !candidates[0].titlePrefixes) return candidates[0].kind
  if (nativeType === 'Epic') return 'opportunity'
  if (nativeType === 'UserStory') return 'software_story'
  if (nativeType === 'Bug') return 'bug'
  return null
}

function parseInternalCardTypeOverrides(rawJson: string): Partial<Record<InternalCardKind, InternalCardTypeOverride>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`TP_INTERNAL_CARD_TYPES_JSON must be valid JSON: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error('TP_INTERNAL_CARD_TYPES_JSON must be an object keyed by internal card kind')
  }

  for (const [kind, override] of Object.entries(parsed)) {
    assertInternalCardKind(kind)
    if (!isRecord(override)) {
      throw new Error(`Internal card type override for "${kind}" must be an object`)
    }
    if (override.nativeType !== undefined && !isNativeCardType(override.nativeType)) {
      throw new Error(`Invalid nativeType for internal card type "${kind}"`)
    }
    if (override.aliases !== undefined && !isStringArray(override.aliases)) {
      throw new Error(`aliases for internal card type "${kind}" must be an array of strings`)
    }
    if (override.titlePrefixes !== undefined && !isStringArray(override.titlePrefixes)) {
      throw new Error(`titlePrefixes for internal card type "${kind}" must be an array of strings`)
    }
    if (override.templateSections !== undefined && !isTemplateSectionArray(override.templateSections)) {
      throw new Error(`templateSections for internal card type "${kind}" must be an array of { key, label } objects`)
    }
  }

  return parsed as Partial<Record<InternalCardKind, InternalCardTypeOverride>>
}

function assertInternalCardKind(kind: string): asserts kind is InternalCardKind {
  if (!(INTERNAL_CARD_KIND_VALUES as readonly string[]).includes(kind)) {
    throw new Error(`Unknown internal card kind "${kind}"`)
  }
}

function normalizeKindToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function cloneRegistry(
  registry: Record<InternalCardKind, InternalCardTypeDefinition>,
): Record<InternalCardKind, InternalCardTypeDefinition> {
  return Object.fromEntries(
    Object.entries(registry).map(([kind, definition]) => [
      kind,
      {
        ...definition,
        aliases: [...definition.aliases],
        titlePrefixes: definition.titlePrefixes ? [...definition.titlePrefixes] : undefined,
        templateSections: definition.templateSections ? definition.templateSections.map((section) => ({ ...section })) : undefined,
      },
    ]),
  ) as Record<InternalCardKind, InternalCardTypeDefinition>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNativeCardType(value: unknown): value is TpNativeCardType {
  return typeof value === 'string'
    && ['General', 'UserStory', 'Bug', 'Feature', 'Epic', 'Request'].includes(value)
}

function isTemplateSectionArray(value: unknown): value is InternalCardTemplateSection[] {
  return Array.isArray(value)
    && value.every((item) => (
      isRecord(item)
      && typeof item.key === 'string'
      && typeof item.label === 'string'
    ))
}
