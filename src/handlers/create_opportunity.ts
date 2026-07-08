import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

type ToolContent = { type: 'text'; text: string }
type ToolResult = { content: ToolContent[] }

export async function handleCreateOpportunity(
  tp: TpClient,
  params: {
    title: string
    summary?: string
    what?: string
    why?: string
    how?: string
    acceptanceCriteria?: string
    iceScore?: number
    impact?: number
    confidence?: number
    ease?: number
    projectId?: string
    releaseId?: string
  },
): Promise<ToolResult> {
  const description = buildOpportunityDescription(params)
  const response = await tp.createEpic<TP.Epic>({
    title: params.title,
    description,
    projectId: params.projectId,
    releaseId: params.releaseId,
  })

  if (!response) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? `\nError: ${diagnostic.message}\nRequest: ${diagnostic.method} ${diagnostic.url}${diagnostic.body ? `\nBody: ${diagnostic.body}` : ''}`
      : ''
    return textResult(`Failed to create Opportunity "${params.title}"${details}`)
  }

  return textResult(JSON.stringify(response))
}

function buildOpportunityDescription(params: {
  summary?: string
  what?: string
  why?: string
  how?: string
  acceptanceCriteria?: string
  iceScore?: number
  impact?: number
  confidence?: number
  ease?: number
}): string | undefined {
  const sections: string[] = []
  addSection(sections, 'Summary', params.summary)
  addSection(sections, 'What', params.what)
  addSection(sections, 'Why', params.why)
  addSection(sections, 'How', params.how)
  addSection(sections, 'Acceptance Criteria', params.acceptanceCriteria)

  const iceParts = [
    params.iceScore !== undefined ? `ICE Score: ${params.iceScore}` : undefined,
    params.impact !== undefined ? `Impact: ${params.impact}` : undefined,
    params.confidence !== undefined ? `Confidence: ${params.confidence}` : undefined,
    params.ease !== undefined ? `Ease: ${params.ease}` : undefined,
  ].filter(Boolean)
  if (iceParts.length > 0) addSection(sections, 'Prioritization', iceParts.join('\n'))

  return sections.length > 0 ? `<div>\n${sections.join('\n')}\n</div>` : undefined
}

function addSection(sections: string[], title: string, value: string | undefined): void {
  const text = value?.trim()
  if (!text) return
  sections.push(`<h3>${escapeHtml(title)}</h3>`)
  sections.push(`<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
