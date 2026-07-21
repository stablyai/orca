import type { AgentType } from './agent-status-types'

/**
 * Serializable contract for the pop-out agent dashboard. The main renderer owns
 * the live store, derives this snapshot, and relays it (through the main
 * process) to the separate pop-out renderer, which renders it presentationally.
 * Every field must be structured-clone-safe (no functions / class instances).
 */

/** The three kanban columns. "Idle" is everything that isn't actively working
 *  and isn't blocking you — this includes explicitly-completed ('done') agents,
 *  which Orca only reports when a completion hook fires, so they're folded in
 *  rather than split into a separate, inconsistently-populated column. */
export type DashboardBucket = 'attention' | 'working' | 'idle'

/** Column order shared by producer and pop-out so they never drift. */
export const DASHBOARD_BUCKET_ORDER: readonly DashboardBucket[] = ['attention', 'working', 'idle']

/** Precise per-card state marker (drives AgentStateDot). Kept distinct from
 *  `bucket` so the "Needs You" column can still show amber (waiting/permission)
 *  vs red (blocked) dots. */
export type DashboardCardDotState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle'

export type DashboardCard = {
  /** Stable identity for React keys. */
  paneKey: string
  /** Resolved live PTY id for the terminal preview, or null when the agent has
   *  no live pane (e.g. a retained/done row whose pane is gone). */
  ptyId: string | null
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  /** One-line task/prompt text shown on the card. */
  task: string
  /** The most recent message the user sent this agent (its current prompt). */
  lastUserMessage?: string
  /** The most recent message the agent sent back. */
  lastAgentMessage?: string
  /** Routing target for click-to-focus. leafId is null when unresolved. */
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
  repoName: string
  worktreeName: string
  /** "Started … ago" display. */
  startedAt: number
  /** When the agent entered its current state — column ordering key (cards
   *  that moved into a bucket most recently sort first). 0 when unknown. */
  stateChangedAt: number
  /** Mirrors the sidebar's unvisited signal: the agent changed state since the
   *  user last acknowledged it (visited its tab / opened its dashboard dialog).
   *  Derived from the app-wide ack map so both surfaces mute in lockstep. */
  unseen: boolean
  /** Short summary of the pending question when bucket === 'attention'. */
  askSummary?: string
}

export type DashboardSnapshot = {
  generatedAt: number
  cards: DashboardCard[]
}

export const EMPTY_DASHBOARD_SNAPSHOT: DashboardSnapshot = { generatedAt: 0, cards: [] }

/** Routing payload for click-to-focus: reveal this agent's pane in the main
 *  window. leafId is null when the pane could not be resolved (best-effort:
 *  the worktree is still activated). */
export type DashboardRevealAgentArgs = {
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
}
