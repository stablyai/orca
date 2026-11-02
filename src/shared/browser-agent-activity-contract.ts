// Main owns which pages an agent drives and where it is about to act; renderers only draw it.

export const BROWSER_AGENT_ACTIVITY_CHANNEL = 'browser:agentActivity'
export const BROWSER_AGENT_CURSOR_CHANNEL = 'browser:agentCursor'
export const BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL = 'browser:agentCursorArrived'

export type BrowserAgentActivityEvent = {
  browserPageId: string
  worktreeId: string | null
  active: boolean
}

/** Where the agent is about to act, in the page's CSS px. */
export type BrowserAgentCursorEvent = {
  browserPageId: string
  sequence: number
  x: number
  y: number
  viewportWidth: number
  viewportHeight: number
  /** A press follows at this point. */
  press: boolean
  /** Main waits for `BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL` with this sequence before acting. */
  awaitsArrival: boolean
}
