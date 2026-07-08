export type AccessMode = "personal" | "shared"

export type PolicyCategory =
  | "read"
  | "comment"
  | "create"
  | "update"
  | "delete"
  | "attachment"
  | "label"
  | "relation"
  | "testWrite"
  | "time"

export type TargetprocessAccessPolicy = {
  allowDeletes: boolean
  allowRelationDeletes: boolean
  allowCreates: boolean
  createLimitPerHour: number
  allowComments: boolean
  commentLimitPerHour: number
  allowUpdates: boolean
  allowAttachments: boolean
  allowLabels: boolean
  allowRelations: boolean
  allowTestWrites: boolean
  allowTimeLogging: boolean
}

export type ToolPolicyDecision =
  | { allowed: true; category: PolicyCategory }
  | { allowed: false; category: PolicyCategory; reason: string }

export const defaultAccessPolicy: TargetprocessAccessPolicy = {
  allowDeletes: false,
  allowRelationDeletes: false,
  allowCreates: true,
  createLimitPerHour: 10,
  allowComments: true,
  commentLimitPerHour: 30,
  allowUpdates: true,
  allowAttachments: true,
  allowLabels: true,
  allowRelations: true,
  allowTestWrites: true,
  allowTimeLogging: true,
}

export const sharedTokenPolicy: TargetprocessAccessPolicy = {
  allowDeletes: false,
  allowRelationDeletes: false,
  allowCreates: false,
  createLimitPerHour: 0,
  allowComments: true,
  commentLimitPerHour: 30,
  allowUpdates: false,
  allowAttachments: false,
  allowLabels: false,
  allowRelations: false,
  allowTestWrites: false,
  allowTimeLogging: false,
}

export function normalizePolicy(input: Partial<TargetprocessAccessPolicy> | undefined): TargetprocessAccessPolicy {
  return {
    ...defaultAccessPolicy,
    ...input,
    createLimitPerHour: normalizeLimit(input?.createLimitPerHour, defaultAccessPolicy.createLimitPerHour),
    commentLimitPerHour: normalizeLimit(input?.commentLimitPerHour, defaultAccessPolicy.commentLimitPerHour),
  }
}

export function toolCategory(toolName: string): PolicyCategory {
  if (toolName.startsWith("get_") || toolName.startsWith("search_") || toolName.startsWith("list_") || toolName === "get_version") {
    return "read"
  }
  if (toolName === "add_comment" || toolName === "add_comment_with_user") return "comment"
  if (toolName === "delete_internal_card" || toolName === "delete_card_relation") return "delete"
  if (toolName === "add_file_attachment") return "attachment"
  if (toolName === "add_card_labels") return "label"
  if (toolName === "create_card_relation") return "relation"
  if (toolName === "create_test_plan" || toolName === "write_test_cases" || toolName === "add_test_cases_to_test_plan") return "testWrite"
  if (toolName === "log_time") return "time"
  if (toolName.startsWith("update_")) return "update"
  if (toolName.startsWith("create_")) return "create"
  return "read"
}

export function decideToolAccess(
  accessMode: AccessMode,
  policy: TargetprocessAccessPolicy,
  toolName: string,
): ToolPolicyDecision {
  const category = toolCategory(toolName)

  if (accessMode === "shared") {
    if (category === "read") return { allowed: true, category }
    if (toolName === "add_comment" && policy.allowComments) return { allowed: true, category }
    return { allowed: false, category, reason: "This tool is not available when using the service Targetprocess token." }
  }

  switch (category) {
    case "read":
      return { allowed: true, category }
    case "comment":
      return policy.allowComments
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Comment tools are disabled in your Targetprocess MCP settings." }
    case "create":
      return policy.allowCreates
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Create tools are disabled in your Targetprocess MCP settings." }
    case "update":
      return policy.allowUpdates
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Update tools are disabled in your Targetprocess MCP settings." }
    case "delete":
      if (toolName === "delete_card_relation") {
        return policy.allowRelationDeletes
          ? { allowed: true, category }
          : { allowed: false, category, reason: "Relation deletion is disabled in your Targetprocess MCP settings." }
      }
      return policy.allowDeletes
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Ticket deletion is disabled in your Targetprocess MCP settings." }
    case "attachment":
      return policy.allowAttachments
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Attachments are disabled in your Targetprocess MCP settings." }
    case "label":
      return policy.allowLabels
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Label changes are disabled in your Targetprocess MCP settings." }
    case "relation":
      return policy.allowRelations
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Relation creation is disabled in your Targetprocess MCP settings." }
    case "testWrite":
      return policy.allowTestWrites
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Test write tools are disabled in your Targetprocess MCP settings." }
    case "time":
      return policy.allowTimeLogging
        ? { allowed: true, category }
        : { allowed: false, category, reason: "Time logging is disabled in your Targetprocess MCP settings." }
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(0, Math.floor(value))
}
