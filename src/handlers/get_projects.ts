import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleGetProjects(tp: TpClient) {
  const response = await tp.getProjects<TP.TpResponse<TP.Project>>()

  if (!response) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? [
        `Error: ${diagnostic.message}`,
        `Request: ${diagnostic.method} ${diagnostic.url}`,
        diagnostic.status !== undefined ? `Status: ${diagnostic.status}` : undefined,
        diagnostic.body ? `Body: ${diagnostic.body}` : undefined,
      ].filter(Boolean).join('\n')
      : `JSON: ${JSON.stringify(response, null, 2)}`

    return {
      content: [{
        type: 'text' as const,
        text: `Failed to get projects\n${details}`
      }],
    }
  }

  const items = response.Items || []
  if (items.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No projects found' }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(items.map((p) => ({ id: p.Id, name: p.Name })))
    }],
  }
}
