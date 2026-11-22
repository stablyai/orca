/** Restart a terminal pane's agent in place: resume its conversation, or start it fresh. */
export type PaneAgentRestartMode = 'resume' | 'fresh'

export type PaneAgentRestartRefusal =
  /** The agent has no resumable conversation here (no session id, or no resume support). */
  | 'no_resume'
  /** Another pane already runs that conversation. */
  | 'held_elsewhere'
  /** The pane is not open in a window that can restart it. */
  | 'pane_unavailable'
  /** No launch command could be built for this agent on this host. */
  | 'no_launch_command'
  | 'failed'

export type PaneAgentRestartRequest = {
  paneKey: string
  mode: PaneAgentRestartMode
  /** The agent the chat showed; used when the pane's own status no longer names one. */
  agent: string
  sessionId: string | null
  transcriptPath: string | null
}

export type PaneAgentRestartResult = { ok: true } | { ok: false; reason: PaneAgentRestartRefusal }

/** What the host renderer answers a relayed restart with. */
export type PaneAgentRestartReply = { requestId: string; result: PaneAgentRestartResult }
