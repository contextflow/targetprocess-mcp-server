import { JSDOM } from 'jsdom'
import {
  getInternalCardTypes,
  inferInternalCardKind,
  resolveInternalCardType,
  type InternalCardKind,
  type InternalCardTypeDefinition,
} from '../internal_card_types.js'
import { tpNativeTypeCollection, type TpClient } from '../tp.js'
import type * as TP from '../types.js'

type ToolContent = { type: 'text'; text: string }
type ToolResult = { content: ToolContent[] }

type MinimalCard = {
  ResourceType?: string
  Id?: number
  Name?: string
  Description?: string | null
  EntityState?: { Name?: string }
  Project?: { Id?: number; Name?: string }
  Release?: { Id?: number; Name?: string }
  Team?: { Id?: number; Name?: string }
  Epic?: { Id?: number; Name?: string }
  Feature?: { Id?: number; Name?: string }
  UserStory?: { Id?: number; Name?: string }
  CustomFields?: TP.CustomField[]
}

export async function handleGetInternalCardTypes(): Promise<ToolResult> {
  const registry = getInternalCardTypes()
  const types = Object.values(registry).map((definition) => ({
    kind: definition.kind,
    label: definition.label,
    nativeType: definition.nativeType,
    collection: tpNativeTypeCollection(definition.nativeType),
    aliases: definition.aliases,
    titlePrefixes: definition.titlePrefixes ?? [],
    templateSections: definition.templateSections ?? [],
    description: definition.description,
  }))

  return textResult(JSON.stringify(types))
}

export async function handleSearchInternalCards(
  tp: TpClient,
  params: {
    keyword: string
    kind?: string
    take?: number
  },
): Promise<ToolResult> {
  const take = params.take ?? 25
  const definitions = definitionsForSearch(params.kind)
  if (definitions.length === 0) {
    return textResult(`Unknown internal card kind: ${params.kind}`)
  }

  const itemByKey = new Map<string, { card: MinimalCard; definition: InternalCardTypeDefinition }>()

  for (const definition of definitions) {
    const entityType = tpNativeTypeCollection(definition.nativeType)
    const [nameResult, descriptionResult] = await Promise.all([
      tp.searchContainsNameText<TP.TpResponse<MinimalCard>>({ text: params.keyword, entityType, take }),
      tp.searchContainsDescriptionText<TP.TpResponse<MinimalCard>>({ text: params.keyword, entityType, take }),
    ])

    for (const card of [...(nameResult?.Items ?? []), ...(descriptionResult?.Items ?? [])]) {
      if (card.Id === undefined) continue
      itemByKey.set(`${definition.nativeType}:${card.Id}`, { card, definition })
    }
  }

  const baseUrl = getClientBaseUrl(tp)
  const items = [...itemByKey.values()].map(({ card, definition }) => normalizeCard(card, definition, baseUrl))
  if (items.length === 0) {
    return textResult(`No internal cards found for keyword: "${params.keyword}"`)
  }

  return textResult(JSON.stringify(items))
}

export async function handleGetInternalCard(
  tp: TpClient,
  params: {
    id: string
    kind: string
  },
): Promise<ToolResult> {
  const definition = resolveInternalCardType(params.kind)
  if (!definition) return textResult(`Unknown internal card kind: ${params.kind}`)

  const card = await tp.getInternalCard<MinimalCard>(definition.nativeType, params.id)
  if (!card) {
    return textResult(`Failed to get ${definition.label} (${definition.nativeType}) id: ${params.id}`)
  }

  return textResult(JSON.stringify(normalizeCard(card, definition, getClientBaseUrl(tp))))
}

export async function handleCreateInternalCard(
  tp: TpClient,
  params: {
    kind: string
    title: string
    description?: string
    sections?: Record<string, string>
    projectId?: string
    teamId?: string
    releaseId?: string
    epicId?: string
    featureId?: string
    entityStateId?: string
    origin?: string
    customFields?: TP.CustomFieldInput[]
  },
): Promise<ToolResult> {
  const definition = resolveInternalCardType(params.kind)
  if (!definition) return textResult(`Unknown internal card kind: ${params.kind}`)

  const description = buildInternalCardDescription(definition, params.description, params.sections)
  let response: unknown

  switch (definition.nativeType) {
    case 'Epic':
      response = await tp.createEpic<TP.Epic>({
        title: params.title,
        description,
        releaseId: params.releaseId,
        projectId: params.projectId,
        customFields: params.customFields,
      })
      break
    case 'Feature':
      response = await tp.createFeature<TP.Feature>({
        title: params.title,
        description,
        epicId: params.epicId,
        releaseId: params.releaseId,
        projectId: params.projectId,
        teamId: params.teamId,
      })
      break
    case 'UserStory':
      response = await tp.createUserStory<TP.UserStory>({
        title: params.title,
        description,
        featureId: params.featureId,
        releaseId: params.releaseId,
        projectId: params.projectId,
        teamId: params.teamId,
      })
      break
    case 'Bug':
      response = await tp.createBugOnly<TP.Bug>({
        title: params.title,
        bugContent: description || params.description || '',
        origin: params.origin,
        projectId: params.projectId,
        teamId: params.teamId,
        entityStateId: params.entityStateId,
      })
      break
    case 'Request':
      response = await tp.createRequest<TP.Request>({
        title: params.title,
        description,
        releaseId: params.releaseId,
        projectId: params.projectId,
        teamId: params.teamId,
        entityStateId: params.entityStateId,
        customFields: params.customFields,
      })
      break
    case 'General':
      return textResult('Creating General cards is not supported by create_internal_card')
  }

  if (!response) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? `\nError: ${diagnostic.message}\nRequest: ${diagnostic.method} ${diagnostic.url}${diagnostic.body ? `\nBody: ${diagnostic.body}` : ''}`
      : ''
    return textResult(`Failed to create ${definition.label} "${params.title}"${details}`)
  }

  return textResult(JSON.stringify(response))
}

export async function handleDeleteInternalCard(
  tp: TpClient,
  params: {
    id: string
    kind: string
  },
): Promise<ToolResult> {
  const definition = resolveInternalCardType(params.kind)
  if (!definition) return textResult(`Unknown internal card kind: ${params.kind}`)

  const result = await tp.deleteCard<unknown>({
    cardId: params.id,
    nativeType: definition.nativeType,
  })

  if (!result.ok) {
    return textResult(
      `Failed to delete ${definition.label} (${definition.nativeType}) id: ${params.id}\n` +
      `HTTP status: ${result.status}\n` +
      `Response body: ${result.body}`,
    )
  }

  return textResult(JSON.stringify({
    deleted: true,
    id: params.id,
    kind: definition.kind,
    nativeType: definition.nativeType,
  }))
}

function definitionsForSearch(kind?: string): InternalCardTypeDefinition[] {
  if (kind) {
    const definition = resolveInternalCardType(kind)
    return definition ? [definition] : []
  }

  const seen = new Set<string>()
  const definitions: InternalCardTypeDefinition[] = []
  for (const definition of Object.values(getInternalCardTypes())) {
    const key = `${definition.kind}:${definition.nativeType}`
    if (seen.has(key)) continue
    seen.add(key)
    definitions.push(definition)
  }
  return definitions
}

function normalizeCard(card: MinimalCard, definition: InternalCardTypeDefinition, baseUrl: string) {
  const inferredKind = inferInternalCardKind(definition.nativeType, card) ?? definition.kind
  const id = card.Id

  return {
    kind: inferredKind,
    label: getInternalCardTypes()[inferredKind as InternalCardKind]?.label ?? definition.label,
    nativeType: definition.nativeType,
    id,
    name: card.Name,
    description: htmlToText(card.Description || ''),
    url: id === undefined || !baseUrl ? undefined : `${baseUrl}/entity/${id}`,
    entityState: card.EntityState?.Name,
    project: card.Project?.Name,
    projectId: card.Project?.Id,
    release: card.Release?.Name,
    releaseId: card.Release?.Id,
    team: card.Team?.Name,
    teamId: card.Team?.Id,
    epic: card.Epic?.Name,
    epicId: card.Epic?.Id,
    feature: card.Feature?.Name,
    featureId: card.Feature?.Id,
    userStory: card.UserStory?.Name,
    userStoryId: card.UserStory?.Id,
    customFields: card.CustomFields ?? [],
  }
}

function buildInternalCardDescription(
  definition: InternalCardTypeDefinition,
  summary?: string,
  sections?: Record<string, string>,
): string | undefined {
  const parts: string[] = ['<div>']

  if (summary) {
    parts.push('<h3>Summary</h3>')
    parts.push(`<p>${escapeHtml(summary)}</p>`)
  }

  for (const section of definition.templateSections ?? []) {
    const value = sections?.[section.key]
    if (!value) continue
    parts.push(`<h3>${escapeHtml(section.label)}</h3>`)
    parts.push(`<p>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`)
  }

  parts.push('</div>')
  return parts.length > 2 ? parts.join('\n') : undefined
}

function htmlToText(html: string): string {
  if (!html) return ''
  try {
    const dom = new JSDOM(`<html><body><div id="content">${html}</div></body></html>`)
    return dom.window.document.getElementById('content')?.textContent || ''
  } catch (error) {
    console.error('Error parsing internal card description:', error)
    return ''
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getClientBaseUrl(tp: TpClient): string {
  return typeof tp.getBaseUrl === 'function' ? tp.getBaseUrl() : ''
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
