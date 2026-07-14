import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleCreateBug(
  tp: TpClient,
  params: {
    title: string
    bugContent: string
    origin?: string
    projectId?: string
    teamId?: string
    entityStateId?: string
  },
) {
  const bugResponse = await tp.createBugOnly<TP.Bug>(params)

  if (!bugResponse) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? [
        `Error: ${diagnostic.message}`,
        `Request: ${diagnostic.method} ${diagnostic.url}`,
        diagnostic.status !== undefined ? `Status: ${diagnostic.status}` : undefined,
        diagnostic.body ? `Body: ${diagnostic.body}` : undefined,
      ].filter(Boolean).join('\n')
      : `JSON: ${JSON.stringify(bugResponse, null, 2)}`

    return {
      content: [{
        type: 'text' as const,
        text: `Failed to create bug "${params.title}"\n${details}`
      }],
    }
  }

  const id = bugResponse.Id
  const warning = tp.getLastRequestWarning?.()
  const response = id === undefined || id === null
    ? { ...bugResponse, ...(warning ? { warning } : {}) }
    : {
      ...bugResponse,
      url: `${tp.getBaseUrl().replace(/\/$/, '')}/entity/${id}`,
      ...(warning ? { warning } : {}),
    }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
  }
}
