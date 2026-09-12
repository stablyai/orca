import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  AgentOwnershipEvidence,
  PtyListedSession
} from '../../../../shared/pty-listed-session'

/** `null` === "no local sample" (e.g. SSH PTY); UI renders as em-dash. */
export type Metric = number | null

/** One `pty.listSessions()` row. Aliased so ownership evidence cannot be dropped locally. */
export type DaemonSession = PtyListedSession

export type UnifiedSessionRow = {
  sessionId: string
  paneKey: string | null
  pid: number
  label: string
  bound: boolean
  /** Ownership as the provider could establish it; anything but `absent` means confirm first. */
  agentOwnership: AgentOwnershipEvidence
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
  /** Execution-host metadata drives the remote chip; missing samples do not. */
  isRemote: boolean
  sessions: UnifiedSessionRow[]
  browsers: BrowserWorkspace[]
}

export type UnifiedProjectGroup = {
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  /** True when any workspace in this project runs over SSH. */
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
  /** From useAppStore: SSH sessions known live but not yet reattached; no other binding sees them. */
  deferredSshSessionIdsByTabId?: Record<string, string>
  /** From useAppStore: per-tab live pane titles (for label resolution). */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** From useAppStore: false until renderer state can distinguish bound/orphan. */
  workspaceSessionReady: boolean
  /** Project display names for sampled and daemon-only groups. */
  repoDisplayNameById: Map<string, string>
  /** Repo connectionId by repo id (null/missing == local). */
  repoConnectionIdById: Map<string, string | null>
  /** Repo runtime-host scope by repo id (missing == keep row). */
  repoRuntimeScopedById: Map<string, boolean>
  /** Browser inventory is open-only; the Resource Manager never scans it in the background. */
  browserTabsByWorktree?: Record<string, BrowserWorkspace[]>
  /** Canonical workspace names and grouping for every resource source. */
  worktreeById?: ReadonlyMap<string, Worktree>
}
