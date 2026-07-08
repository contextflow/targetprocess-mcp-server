import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleCreateTask(
  tp: TpClient,
  params: TP.CreateTaskInputSchema,
) {
  const response = await tp.createTask<TP.Task>(params)

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
        text: `Failed to create task "${params.title}"\n${details}`
      }],
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
  }
}
