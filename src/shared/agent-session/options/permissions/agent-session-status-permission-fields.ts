/** Permission fields of an agent session status summary. */
export type AgentSessionStatusPermissionFields = {
  /** The chat's saved permission mode; a client re-reads options when it or `model` moves. */
  permissionMode?: string
  /** Permission choice the currently fenced provider child applies; its launch choice until a
   *  pick reaches it. Named for the launch because older clients read it that way. */
  launchPermissionMode?: string
  runtimePermission?: { fence: number; mode: string | null } | null
}
