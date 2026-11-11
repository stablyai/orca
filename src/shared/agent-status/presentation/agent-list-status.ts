/** A row's status in the desktop Agents list; the renderer's AgentDotState is this union. */
export type AgentListStatus =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'interrupted'
  // Transcript-derived failure is an outcome, distinct from live blocked attention.
  | 'failed'
  | 'done'
  | 'idle'
  // A live PTY with stale reporting proves only missing evidence, not idle/work/completion.
  | 'unverifiable'
  // The turn ended without a proven outcome; use the missing-evidence glyph, never completion.
  | 'unconfirmed'
  // Sidebar combines blocked/waiting as permission; retain its vocabulary with the shared question glyph/token.
  | 'permission'

// Use exhaustive, unique attention ranks so new states fail typecheck and recency cannot reorder headers.
export const AGENT_LIST_STATUS_RANK: Record<AgentListStatus, number> = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  failed: 3,
  unconfirmed: 4,
  working: 5,
  monitoring: 6,
  // A user's Stop is not news, so it follows live work, but it is not a finish either.
  interrupted: 7,
  unverifiable: 8,
  done: 9,
  idle: 10
}

/** How the desktop Agents list shows one agent pane; unlisted panes are not in the list at all. */
export type AgentListVerdict =
  | { listed: false }
  | {
      listed: true
      status: AgentListStatus
      unread: boolean
      clearable: boolean
      /** The row's recency, newest first within a status. */
      sortAt: number
      title: string
      /** The coordinator this worker nests under. */
      childOf?: string
      /** A finished worker the list hides while child agents are hidden. */
      foldedChild?: true
    }

/** The desktop window's verdicts by pane key, as of `publishedAt`. */
export type AgentListPublication = {
  publishedAt: number
  verdicts: Record<string, AgentListVerdict>
}

/** A paired client's Agents-list change; the desktop window applies it with its own Activity actions. */
export type AgentPaneActivityChange = {
  kind: 'read' | 'unread' | 'clear'
  paneKeys: string[]
}

export type AgentPaneActivityRequest = AgentPaneActivityChange & { requestId: string }

export type AgentPaneActivityReply =
  | { requestId: string; publication: AgentListPublication }
  | { requestId: string; error: string }
