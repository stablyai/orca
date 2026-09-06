import type { DashboardCardHostKind } from './dashboard-snapshot'
import type { ExecutionHostId } from './execution-host'
import type { TerminalTab } from './terminal-tab-types'

export type SessionGridLayoutPreset = 'auto' | '1x2' | '2x1' | '2x2' | '3x2' | '3x3'

export const SESSION_GRID_PRESETS: readonly SessionGridLayoutPreset[] = [
  'auto',
  '1x2',
  '2x1',
  '2x2',
  '3x2',
  '3x3'
]

export type SessionGridScrollMode = 'row' | 'page' | 'free'

export type SessionGridFilter = 'all' | (string & {})

export const SESSION_GRID_SCROLL_MODES: readonly SessionGridScrollMode[] = ['row', 'page', 'free']

/**
 * Who a plain wheel over a card belongs to. Shift+wheel always goes to the
 * other one. 'auto' lets the terminal scroll until its end, then the grid.
 */
export type SessionGridWheelTarget = 'auto' | 'terminal' | 'grid'

export const SESSION_GRID_WHEEL_TARGETS: readonly SessionGridWheelTarget[] = [
  'auto',
  'terminal',
  'grid'
]

/** Preset off the wire or disk, or undefined for anything the switch would not handle. */
export function normalizeSessionGridPreset(value: unknown): SessionGridLayoutPreset | undefined {
  return (SESSION_GRID_PRESETS as readonly unknown[]).includes(value)
    ? (value as SessionGridLayoutPreset)
    : undefined
}

export function normalizeSessionGridScrollMode(value: unknown): SessionGridScrollMode | undefined {
  return (SESSION_GRID_SCROLL_MODES as readonly unknown[]).includes(value)
    ? (value as SessionGridScrollMode)
    : undefined
}

export function normalizeSessionGridWheelTarget(
  value: unknown
): SessionGridWheelTarget | undefined {
  return (SESSION_GRID_WHEEL_TARGETS as readonly unknown[]).includes(value)
    ? (value as SessionGridWheelTarget)
    : undefined
}

/**
 * The grid's state axis, orthogonal to the workspace filter: 'all' plus the
 * dashboard's bucket vocabulary, so both surfaces name a card's state the same way.
 */
export type SessionGridStateFilter = 'all' | 'attention' | 'working' | 'done' | 'idle'

export const SESSION_GRID_STATE_FILTERS: readonly SessionGridStateFilter[] = [
  'all',
  'attention',
  'working',
  'done',
  'idle'
]

export function normalizeSessionGridStateFilter(
  value: unknown
): SessionGridStateFilter | undefined {
  return (SESSION_GRID_STATE_FILTERS as readonly unknown[]).includes(value)
    ? (value as SessionGridStateFilter)
    : undefined
}

/** The tab bar's activity vocabulary (`terminalTabActivityToAgentDotState`), with `idle` for a tab showing no live state. */
export type SessionGridDotState =
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'interrupted'
  | 'done'
  | 'idle'

/**
 * Which state-filter bucket a card's dot falls in; 'all' is not a bucket, it is the absence of one.
 * Mirrors `dashboardBucketForDotState`, where `attention` is exactly blocked/waiting — the grid's
 * `permission`. `interrupted` is NOT attention: it only ever rides a finished turn (agent-status
 * coerces the flag away unless the state is `done`), `isTerminalTabActivityLive` excludes it, and
 * it is the user's own Ctrl+C — so it buckets with the outcome it modifies.
 * No `default`: under `noImplicitReturns` a new dot state fails to compile until it picks a bucket.
 */
export function sessionGridDotStateBucket(
  dotState: SessionGridDotState
): Exclude<SessionGridStateFilter, 'all'> {
  switch (dotState) {
    case 'permission':
      return 'attention'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
    case 'interrupted':
      return 'done'
    case 'idle':
      return 'idle'
  }
}

/**
 * The tab bar's attention ladder (`resolveTerminalTabAttentionBadge`), mirrored here
 * because `src/shared` cannot import the renderer — same reason as `SessionGridDotState`.
 * The builder assigns the renderer's union straight into this field, so a new member
 * there fails `pnpm tc` until this mirror grows it.
 */
export type SessionGridAttentionBadge =
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'interrupted'
  | 'unread'
  | 'done'

/**
 * The dashboard's host vocabulary minus `wsl`: that one is read off a live pty's
 * platform per card, and the badge hides for it exactly as it does for `local`,
 * so the listing resolves the workspace's host and stops there.
 */
export type SessionGridHostKind = Exclude<DashboardCardHostKind, 'wsl'>

export type SessionGridItem = {
  tabId: string
  /** The tab's live pty, or null while it is parked or still spawning. Never a guess. */
  ptyId: string | null
  /** Pane key of that pty's leaf; what the input resolver keys agent evidence on. */
  paneKey: string | null
  worktreeId: string
  repoId: string
  repoName: string
  worktreeName: string
  branch?: string
  title: string
  dotState: SessionGridDotState
  /** A finished turn nobody has looked at — the bell, shared with the tab bar and the Dock. */
  hasUnread: boolean
  /**
   * What the card's glyph shows: the ladder's verdict over the live status AND the unread
   * flag, so `unread` can beat a stale `done`. Null means quiet — no glyph but the idle dot.
   * Kept beside `dotState` rather than derived from it: `active` and `inactive` both narrow
   * to the same absent dot, so the ladder can tell them apart when `dotState` no longer can.
   */
  attentionBadge: SessionGridAttentionBadge | null
  /** Kept out of the grid by the user. A view, not a model: the pty stays live and the tab stays put. */
  isHiddenFromGrid: boolean
  contextPercent?: number
  createdAt: number
  /** Where this session's work actually runs. `local` on most cards, and the badge hides there. */
  hostKind: SessionGridHostKind
  executionHostId: ExecutionHostId
  /** What to call the remote host; absent on a local one. */
  hostLabel?: string
  /** Host facts the per-card terminal-input resolver needs; mirrors the dashboard snapshot. */
  cwd: string
  shellOverride: TerminalTab['shellOverride']
  launchAgent: TerminalTab['launchAgent']
}
