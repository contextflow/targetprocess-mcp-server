import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleAddCardTags(
  tp: TpClient,
  params: {
    id: string
    labels: string[]
    nativeType?: TP.TpNativeCardType
  },
) {
  const labels = params.labels.map((label) => label.trim()).filter(Boolean)
  if (labels.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: 'At least one non-empty label is required'
      }],
    }
  }

  const result = await tp.addCardTags<TP.General>({
    cardId: params.id,
    labels,
    nativeType: params.nativeType,
  })

  if (!result.ok) {
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to add labels to card id: ${params.id}\nHTTP status: ${result.status}\nResponse body: ${result.body}`
      }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(result.data ?? { updated: true, cardId: params.id, labels })
    }],
  }
}
