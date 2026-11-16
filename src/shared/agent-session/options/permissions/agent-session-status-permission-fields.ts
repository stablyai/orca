/** Permission fields of an agent session status summary. */
export type AgentSessionStatusPermissionFields = {
  /** The chat's saved permission mode; a client re-reads options when it or `model` moves. */
  permissionMode?: string
  /** Permission choice used to start the currently fenced provider child. */
  launchPermissionMode?: string
  runtimePermission?: { fence: number; mode: string | null } | null
}
