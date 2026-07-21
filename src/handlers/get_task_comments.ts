import { JSDOM } from 'jsdom'
import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleGetTaskComments(tp: TpClient, id: string, results?: number) {
  const limit = results ?? 25
  const response = await tp.getTaskComments<TP.TpResponse<TP.Comment>>(id, limit)

  if (!response) {
    return {
      content: [{ type: 'text' as const, text: `Failed to get comments for task id: ${id}` }],
    }
  }

  const items = response.Items || []
  const parsedItems = items.map((item) => {
    const html = item.Description || ''
    const dom = new JSDOM(`<html><body><div id="content">${html}</div></body></html>`)
    return {
      id: item.Id,
      author: item.Owner
        ? { id: item.Owner.Id, fullName: item.Owner.FullName }
        : null,
      createDate: item.CreateDate,
      description: html,
      text: dom.window.document.getElementById('content')?.textContent || '',
    }
  })

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        items: parsedItems,
        pagination: {
          count: parsedItems.length,
          limit,
          hasMore: Boolean(response.Next),
        },
      }),
    }],
  }
}
