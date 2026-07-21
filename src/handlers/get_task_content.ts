import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'
import { normalizeTask } from './get_user_story_tasks.js'

export async function handleGetTaskContent(tp: TpClient, id: string) {
  const task = await tp.getTask<TP.Task>(id)

  if (!task) {
    return {
      content: [{ type: 'text' as const, text: `Failed to get task, id: ${id}` }],
    }
  }

  const baseUrl = tp.getBaseUrl().replace(/\/$/, '')
  const userStory = task.UserStory
    ? {
      id: task.UserStory.Id,
      name: task.UserStory.Name,
      url: `${baseUrl}/entity/${task.UserStory.Id}`,
    }
    : null

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ...normalizeTask(tp, task), userStory }),
    }],
  }
}
