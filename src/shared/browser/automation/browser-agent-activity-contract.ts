// Main owns which pages an agent drives and where it is about to act; renderers only draw it.

export const BROWSER_AGENT_ACTIVITY_CHANNEL = 'browser:agentActivity'
export const BROWSER_AGENT_CURSOR_CHANNEL = 'browser:agentCursor'
export const BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL = 'browser:agentCursorArrived'
export const BROWSER_AGENT_VIEWPORT_CHANNEL = 'browser:agentViewportApplied'

export type BrowserAgentActivityEvent = {
  browserPageId: string
  worktreeId: string | null
  active: boolean
  /** Set while an SSH host's orca CLI drives the page through the desktop browser bridge. */
  controllerHostLabel?: string
  /** The chat whose agent sent the command; absent for older CLIs, remote hosts and terminal agents. */
  agentSessionId?: string
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

/** An agent set the page's viewport; the pane sizes its page box to it, as a preset does. */
export type BrowserAgentViewportEvent = {
  browserPageId: string
  width: number
  height: number
}
