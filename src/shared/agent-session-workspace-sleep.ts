// Why: `agentSession.sleepWorkspace` params are strict, so only a host advertising this is sent
// `markAsleep`; an older one stops the chats and marks nothing, leaving their workspace awake.
export const AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY =
  'agent-session.workspace-sleep-mark.v1' as const

export type AgentSessionWorkspaceSleepResult = {
  stoppedSessionIds: string[]
  failures?: {
    sessionId?: string
    reason: 'inventory-unavailable' | 'stop-unverifiable'
  }[]
}
