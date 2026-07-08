import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleCreateUserStory(
  tp: TpClient,
  params: {
    title: string
    description?: string
    featureId?: string
    releaseId?: string
    projectId?: string
    teamId?: string
  },
) {
  const response = await tp.createUserStory<TP.UserStory>(params)

  if (!response) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? `\nError: ${diagnostic.message}\nRequest: ${diagnostic.method} ${diagnostic.url}${diagnostic.body ? `\nBody: ${diagnostic.body}` : ''}`
      : `\n JSON: ${JSON.stringify(response, null, 2)}`
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to create user story "${params.title}"${details}`
      }],
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
  }
}
