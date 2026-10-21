export type AgentSessionWorkspaceSleepResult = {
  stoppedSessionIds: string[]
  failures?: {
    sessionId?: string
    reason: 'inventory-unavailable' | 'stop-unverifiable'
  }[]
}
