// Strict sleepWorkspace params accept markAsleep only when advertised; older hosts stop chats without marking the workspace asleep.
export const AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY =
  'agent-session.workspace-sleep-mark.v1' as const

export type AgentSessionWorkspaceSleepResult = {
  stoppedSessionIds: string[]
  failures?: {
    sessionId?: string
    reason: 'inventory-unavailable' | 'stop-unverifiable'
  }[]
}
