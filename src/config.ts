import "dotenv/config";

function normalizeTpBaseUrl(rawUrl: string | undefined): string {
  const value = rawUrl?.trim() || ""
  if (!value) return ""

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("TP_BASE_URL must be a valid HTTPS URL")
  }

  if (parsed.protocol !== "https:") {
    throw new Error("TP_BASE_URL must use https://")
  }

  return parsed.toString().replace(/\/$/, "")
}

export const config = {
  tp: {
    url: normalizeTpBaseUrl(process.env.TP_BASE_URL),
    token: process.env.TP_TOKEN?.trim() || "",
    ownerId: process.env.TP_OWNER_ID?.trim() || "",
    projectId: process.env.TP_PROJECT_ID?.trim() || "",
    teamId: process.env.TP_TEAM_ID?.trim() || "",

    processId: process.env.TP_PROCESS_ID?.trim() || "",
    userStoryWorkflowId: process.env.TP_USER_STORY_WORKFLOW_ID?.trim() || "",
    bugWorkflowId: process.env.TP_BUG_WORKFLOW_ID?.trim() || "",
  }
}
