import type { TpClient } from '../tp.js'

export async function handleAddFileAttachment(
  tp: TpClient,
  params: {
    id: string
    fileName: string
    fileContentBase64: string
  },
) {
  const response = await tp.addAttachedFile(params.id, {
    fileName: params.fileName,
    fileContent: params.fileContentBase64,
  })

  if (!response) {
    return {
      content: [{
        type: 'text' as const,
        text: `Failed to attach file "${params.fileName}" to card id: ${params.id}`
      }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        attached: true,
        cardId: params.id,
        fileName: params.fileName,
        response,
      })
    }],
  }
}
