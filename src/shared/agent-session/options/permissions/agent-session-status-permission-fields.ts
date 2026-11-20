/** Permission choices of the currently fenced provider child. */
export type AgentSessionChildPermissionFields = {
  /** Permission choice used to start the child. */
  launchPermissionMode?: string
  /** Permission choice the child applies now; absent from hosts that only report its launch. */
  runningPermissionMode?: string
}

/** Permission fields of an agent session status summary. */
export type AgentSessionStatusPermissionFields = AgentSessionChildPermissionFields & {
  /** The chat's saved permission mode; a client re-reads options when it or `model` moves. */
  permissionMode?: string
  runtimePermission?: { fence: number; mode: string | null } | null
}
