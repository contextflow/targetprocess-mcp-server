import type { TpClient } from '../tp.js'
import type * as TP from '../types.js'

export async function handleGetUserStoryTasks(tp: TpClient, id: string, results?: number) {
  const limit = results ?? 100
  const response = await tp.getUserStoryTasks<TP.TpResponse<TP.Task>>(id, limit)

  if (!response) {
    return {
      content: [{ type: 'text' as const, text: `Failed to get tasks for user story id: ${id}` }],
    }
  }

  const items = response.Items || []
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        items: items.map((task) => normalizeTask(tp, task)),
        pagination: {
          count: items.length,
          limit,
          hasMore: Boolean(response.Next),
        },
      }),
    }],
  }
}

export function normalizeTask(tp: TpClient, task: TP.Task) {
  const baseUrl = tp.getBaseUrl().replace(/\/$/, '')
  return {
    id: task.Id,
    name: task.Name,
    description: task.Description ?? null,
    state: task.EntityState ? { id: task.EntityState.Id, name: task.EntityState.Name } : null,
    assignedUser: task.AssignedUser
      ? { id: task.AssignedUser.Id, fullName: task.AssignedUser.FullName }
      : null,
    project: task.Project ? { id: task.Project.Id, name: task.Project.Name } : null,
    team: task.Team ? { id: task.Team.Id, name: task.Team.Name } : null,
    responsibleTeam: task.ResponsibleTeam
      ? {
        id: task.ResponsibleTeam.Id,
        team: task.ResponsibleTeam.Team
          ? { id: task.ResponsibleTeam.Team.Id, name: task.ResponsibleTeam.Team.Name }
          : null,
        state: task.ResponsibleTeam.EntityState
          ? { id: task.ResponsibleTeam.EntityState.Id, name: task.ResponsibleTeam.EntityState.Name }
          : null,
      }
      : null,
    estimate: {
      effort: task.Effort ?? null,
      completed: task.EffortCompleted ?? null,
      remaining: task.EffortToDo ?? null,
    },
    time: {
      spent: task.TimeSpent ?? null,
      remaining: task.TimeRemain ?? null,
    },
    createDate: task.CreateDate ?? null,
    modifyDate: task.ModifyDate ?? null,
    url: `${baseUrl}/entity/${task.Id}`,
  }
}
