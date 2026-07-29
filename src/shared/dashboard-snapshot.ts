import type { AgentType } from './agent-status-types'
import type { RepoIcon } from './repo-icon'

/**
 * Serializable contract for the pop-out agent dashboard. The main renderer owns
 * the live store, derives this snapshot, and relays it (through the main
 * process) to the separate pop-out renderer, which renders it presentationally.
 * Every field must be structured-clone-safe (no functions / class instances).
 */

/** Agent lifecycle columns; idle is optional while completed agents remain visible. */
export type DashboardBucket = 'attention' | 'working' | 'done' | 'idle'

/** Column order shared by producer and pop-out so they never drift. */
export const DASHBOARD_BUCKET_ORDER: readonly DashboardBucket[] = [
  'attention',
  'working',
  'done',
  'idle'
]

/** Max length of a card's display labels. The producer truncates to this and
 *  the main-process validator enforces it, so an unbounded name (a long
 *  `terminal rename`, an OSC title) cannot cost the card its place on the board. */
export const DASHBOARD_MAX_LABEL_LENGTH = 1_024

/** Kept distinct from `bucket` so attention cards retain their precise dot state. */
export type DashboardCardDotState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle'

export type DashboardCardReview = {
  number: number
  state: 'open' | 'closed' | 'merged' | 'draft'
}

export type DashboardCardSubagent = {
  id: string
  name: string
  dotState: DashboardCardDotState
}

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
  workspaceStatusId?: string
  workspaceStatusLabel?: string
  workspaceStatusColor?: string
  /** True when the workspace links a review whose live state is not cached yet. */
  hasReview?: boolean
  review?: DashboardCardReview
  subagents?: DashboardCardSubagent[]
  /** "Started … ago" display. */
  startedAt: number
  /** When the agent last entered `done`, or null if it never finished. Drives
   *  the card's time column: finished cards read time-since-finish (parity with
   *  the left worktree sidebar), active cards fall back to startedAt. */
  finishedAt: number | null
  /** When the agent entered its current state — column ordering key (cards
   *  that moved into a bucket most recently sort first). 0 when unknown. */
  stateChangedAt: number
  /** Mirrors the sidebar's unvisited signal: the agent changed state since the
   *  user last acknowledged it (visited its tab / opened its dashboard dialog).
   *  Derived from the app-wide ack map so both surfaces mute in lockstep. */
  unseen: boolean
  /** Short summary of the pending question when bucket === 'attention'. */
  askSummary?: string
  /** The tab's conversation name, resolved exactly as the sidebar's agent rows
   *  resolve it. Undefined when no usable name exists (status-only titles). */
  conversationName?: string
}

export type DashboardFilterOption = {
  id: string
  label: string
  color?: string
}

export type DashboardFilterOptions = {
  projects: DashboardFilterOption[]
  workspaceStatuses: DashboardFilterOption[]
}

export type DashboardSnapshot = {
  generatedAt: number
  cards: DashboardCard[]
  showIdle?: boolean
  /** Available filter dimensions are store-derived so zero-card projects and
   *  statuses remain selectable. Optional for preload-version compatibility. */
  filterOptions?: DashboardFilterOptions
  /** Icons for the repos the cards belong to. Keyed by repoId rather than
   *  carried per card: image icons are data URLs up to 400KB, and the snapshot
   *  is republished several times a second. Optional so a pop-out running
   *  pre-upgrade code still accepts the payload. */
  repoIconsByRepoId?: Record<string, RepoIcon | null>
}

export const EMPTY_DASHBOARD_SNAPSHOT: DashboardSnapshot = {
  generatedAt: 0,
  cards: [],
  filterOptions: { projects: [], workspaceStatuses: [] },
  repoIconsByRepoId: {}
}

/** Routing payload for click-to-focus: reveal this agent's pane in the main
 *  window. leafId is null when the pane could not be resolved (best-effort:
 *  the worktree is still activated). */
export type DashboardRevealAgentArgs = {
  repoId: string
  worktreeId: string
  tabId: string
  leafId: string | null
}
