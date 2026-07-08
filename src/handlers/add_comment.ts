import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleAddComment(tp: TpClient, id: string, comment: string) {
  const result = await tp.addComment<TP.Comment>(id, comment)

  if (!result.ok) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? `\nRequest: ${diagnostic.method} ${diagnostic.url}${diagnostic.body ? `\nAttempted body: ${diagnostic.body}` : ''}`
      : ''
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to add comment to card id: ${id}\nHTTP status: ${result.status}${details}\nResponse body: ${result.body}`
      }],
    }
  }

  const response = result.data ?? { added: true, cardId: id }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
  }
}

export async function handleCanComment(tp: TpClient, id: string) {
  const response = await tp.getGeneral<{ Id?: number; Name?: string; ResourceType?: string; EntityType?: { Name?: string } }>(id)
  if (!response) {
    const diagnostic = tp.getLastRequestDiagnostic?.()
    const details = diagnostic
      ? `\nRequest: ${diagnostic.method} ${diagnostic.url}${diagnostic.body ? `\nBody: ${diagnostic.body}` : ''}`
      : ''
    return {
      content: [{
        type: 'text' as const,
        text: `Could not validate comment support for card id: ${id}${details}`,
      }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: response.Id ?? Number(id),
        name: response.Name,
        nativeType: response.ResourceType || response.EntityType?.Name,
        collection: 'Comments',
        addCommentSupported: true,
      }),
    }],
  }
}
