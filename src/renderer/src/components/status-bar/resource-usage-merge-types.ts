import type {
  BrowserWorkspace,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree
} from '../../../../shared/types'

/** `null` === "no local sample" (e.g. SSH PTY); UI renders as em-dash. */
export type Metric = number | null

export type DaemonSession = {
  id: string
  cwd: string
  title: string
}

export type UnifiedSessionRow = {
  sessionId: string
  paneKey: string | null
  pid: number
  label: string
  bound: boolean
  tabId: string | null
  cpu: Metric
  memory: Metric
  hasLocalSamples: boolean
}

export type UnifiedWorktreeRow = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  history: number[]
  hasLocalSamples: boolean
  /** Why: repo connectionId, not sample presence, drives the remote chip. */
  isRemote: boolean
  sessions: UnifiedSessionRow[]
  browsers: BrowserWorkspace[]
}

export type UnifiedProjectGroup = {
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  /** Why: kept for callsite stability; this now means SSH-backed repo rows. */
  hasRemoteChildren: boolean
  worktrees: UnifiedWorktreeRow[]
}

export type MergeContext = {
  /** From useAppStore: maps worktreeId -> tabs[] for tab-walk resolution. */
  tabsByWorktree: Record<string, TerminalTab[]>
  /** From useAppStore: maps tabId -> ptyIds[] for the bound check. */
  ptyIdsByTabId: Record<string, string[]>
  /** From useAppStore: persisted per-leaf PTY wake hints for deferred reattach. */
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  /** From useAppStore: per-tab live pane titles (for label resolution). */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** From useAppStore: false until renderer state can distinguish bound/orphan. */
  workspaceSessionReady: boolean
  /** Repo display names by repo id for daemon-only groups. */
  repoDisplayNameById: Map<string, string>
  /** Repo connectionId by repo id (null/missing == local). */
  repoConnectionIdById: Map<string, string | null>
  /** Repo runtime-host scope by repo id (missing == keep row). */
  repoRuntimeScopedById: Map<string, boolean>
  /** Browser inventory is open-only; the Resource Manager never scans it in the background. */
  browserTabsByWorktree?: Record<string, BrowserWorkspace[]>
  /** Canonical worktrees keep browser-only workspace rows out of synthetic buckets. */
  worktreeById?: ReadonlyMap<string, Worktree>
}
