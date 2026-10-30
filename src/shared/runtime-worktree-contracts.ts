import type { SmartTier } from './sidebar-list/sort-stamps'
import type { AgentStatusState, AgentType, AgentWorkingMode } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { ProgramStatusFacet } from './program-status/facet'
import type { CheckStatus } from './github/pull-request-types'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentSubagentSnapshot } from './agent-status-subagent-snapshot'
import type { RuntimeTerminalInteractiveWait } from './runtime-terminal-contracts'
import type { BaseRefSearchResult, Repo } from './repo-types'
import type { CreateWorktreeResult, RemoveWorktreeResult } from './worktree/create-types'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeLineageWarning
} from './worktree/lineage-types'
import type { RuntimeListingHostScope } from './runtime-listing-host-scope'
import type { GitWorktreeInfo, Worktree } from './worktree/types'
import type { WorkspaceStatusWarning } from './workspace-status-warning'
import type { WorktreeStatus } from './worktree-status-rollup'

export type RuntimeWorktreeSetResult = {
  worktree: RuntimeWorktreeRecord
  /** Older hosts omit warnings; metadata writes still succeed. */
  warnings?: WorkspaceStatusWarning[]
}

export type RuntimeWorktreeAgentRow = {
  paneKey: string
  parentPaneKey: string | null
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  agentType: AgentType | null
  prompt: string
  taskTitle: string | null
  displayName: string | null
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  /** Main-agent state/verdict/clock even while subagents keep the row working; old hosts omit it, falling back to interrupted. */
  mainAgent?: AgentMainAgentStatus
  /** Same as `terminal show`, only when requested: null is "looked, no wait"; absent is not evaluated (structured workers, old hosts). */
  agentWait?: RuntimeTerminalInteractiveWait | null
  stateStartedAt: number
  updatedAt: number
  /** Native canonical views win over the CLI roster, including an explicit empty list. */
  children?: AgentChildWorkView[]
  subagents?: AgentSubagentSnapshot[]
  /** The host's freshness verdict; child clocks cannot be compared with the phone's clock. */
  subagentObservation?: 'live' | 'unverifiable'
  restoredUnconfirmed?: boolean
  /** A structured host still owns the provider child, so age alone cannot stale it. Old hosts omit this. */
  structuredHostOwned?: true
  /** A connected PTY backs the row, so a stale row reads "No update in …" rather than idle. Old hosts omit this. */
  hasLivePty?: true
  /** The program's own OSC 7501 report; never decides `state`. Optional: old hosts never send it. */
  programStatus?: ProgramStatusFacet
}

export type RuntimeWorktreePsSummary = {
  workspaceKind?: 'git' | 'folder-workspace'
  worktreeId: string
  repoId: string
  hostId?: Worktree['hostId']
  terminalPlatform?: NodeJS.Platform
  repo: string
  path: string
  priorWorktreeIds?: string[]
  branch: string
  isArchived: boolean
  isMainWorktree: boolean
  hasHostSidebarActivity: boolean
  worktreeInstanceId?: string
  lineageWorktreeInstanceId?: string
  parentWorktreeInstanceId?: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  displayName: string
  workspaceStatus: string
  sortOrder: number
  manualOrder?: number
  lastActivityAt?: number
  /** The owning host's Smart stamps (sidebar-list/sort-stamps.ts); absent tier is Rest. */
  smartTier?: SmartTier
  smartAt?: number
  /** Set by a host that writes sort stamps: clients sort Recent and Smart by them alone. */
  sortedByStamps?: true
  createdAt?: number
  creatorProvenance?: Worktree['creatorProvenance']
  linkedIssue: number | null
  /** The cached PR the desktop's PR lanes read, else a linked number with state UNCACHED_LINKED_PR_STATE. Old hosts omit title/url/checks. */
  linkedPR: {
    number: number
    state: string
    title?: string
    url?: string
    checksStatus?: CheckStatus
  } | null
  linkedLinearIssue: string | null
  linkedGitLabMR: number | null
  linkedGitLabIssue: number | null
  linkedItems?: Worktree['linkedItems']
  comment: string
  isPinned: boolean
  isActive: boolean
  unread: boolean
  liveTerminalCount: number
  hasAttachedPty: boolean
  /** Lost-contact terminals are neither liveTerminalCount nor exited; current hosts send even zero, old hosts omit. */
  unverifiableTerminalCount?: number
  lastOutputAt: number | null
  preview: string
  status: RuntimeWorktreeStatus
  /** Optional discriminator for a working workspace; older clients fall back to ordinary working. */
  workingMode?: AgentWorkingMode
  /** The desktop sidebar dot, including failed/interrupted/unconfirmed; older hosts omit it. */
  sidebarStatus?: WorktreeStatus
  agents: RuntimeWorktreeAgentRow[]
  /** See `Worktree.removing`; sent only to clients that advertise background removal. */
  removing?: true
  /** See `GitWorktreeInfo.removalError`. */
  removalError?: string
  /** Host-derived workspace kinds. Missing defaultBranch retains reader guesses; other missing flags show the row.
   * Older hosts omit these facts. */
  defaultBranch?: boolean
  automationCreated?: true
  /** The automation's name when it made the row; older hosts send only `automationCreated`. */
  automationName?: string
  cliCreated?: true
  detachedHead?: true
  /** Other-client classification for this host’s own phone, which shares its filter setting. */
  desktopOtherClient?: true
}

export type RuntimeGitLocalBranches = {
  current: string | null
  branches: string[]
}

export type RuntimeSpeechModelSummary = {
  id: string
  label: string
  provider: 'local' | 'openai'
  sizeBytes: number | null
  recommended: boolean
  status: 'ready' | 'not-downloaded' | 'downloading' | 'extracting' | 'error'
  progress: number | null
}

export type RuntimeSpeechSetupState = {
  enabled: boolean
  selectedModelId: string
  dictationMode: 'toggle' | 'hold'
  models: RuntimeSpeechModelSummary[]
}

export type RuntimeGitCheckoutResult = {
  ok: true
  branch: string
}

/** A linked PR the host has no cached state for: it shows a badge but, like desktop, sits in the In progress lane. */
export const UNCACHED_LINKED_PR_STATE = 'unknown'

export type RuntimeWorktreeStatus = 'active' | 'working' | 'permission' | 'done' | 'inactive'

export type RuntimeWorktreeRecord = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  git: GitWorktreeInfo
}

export type RuntimeWorktreeCreateResult = {
  worktree: RuntimeWorktreeRecord
  lineage: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings: WorktreeLineageWarning[]
  warning?: string
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  agentTerminalHandle?: string
}

export type RuntimeWorktreeRemoveResult = RemoveWorktreeResult & {
  removed: boolean
  warning?: string
}

export type RuntimeWorktreePsResult = {
  worktrees: RuntimeWorktreePsSummary[]
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
}

export type RuntimeWorktreePsSnapshotResult = RuntimeWorktreePsResult & { snapshotId: string }

export type RuntimeWorktreePsUnchangedResult = {
  unchanged: true
  snapshotId: string
}

export type RuntimeWorktreePsConditionalResult =
  | RuntimeWorktreePsSnapshotResult
  | RuntimeWorktreePsUnchangedResult

export type RuntimeRepoList = { repos: Repo[] }

export type RuntimeRepoSearchRefs = {
  refs: string[]
  refDetails?: BaseRefSearchResult[]
  truncated: boolean
}

export type RuntimeWorktreeListResult = {
  worktrees: RuntimeWorktreeRecord[]
  totalCount: number
  truncated: boolean
  /** Absent from hosts that predate the field; treat that scope as unverifiable. */
  hostScope?: RuntimeListingHostScope
}
