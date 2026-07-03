import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleAddComment(tp: TpClient, id: string, comment: string) {
  const result = await tp.addComment<TP.Comment>(id, comment)

  if (!result.ok) {
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to add comment to card id: ${id}\nHTTP status: ${result.status}\nResponse body: ${result.body}`
      }],
    }
  }

  const response = result.data ?? { added: true, cardId: id }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
  }
}
