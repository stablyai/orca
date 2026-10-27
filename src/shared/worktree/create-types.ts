import type { WorktreeCatalogVersion } from './catalog-version'
import type { ExecutionHostId } from '../execution-host'
import type { ArchiveHookOverride } from './archive-hook-removal-gate'
import type { WorkspaceSource } from '../workspace-source'
import type { TaskSourceContext } from '../task-source-context'
import type { WorkspaceKey } from '../folder-workspace-types'
import type { TuiAgent } from '../tui-agent'
import type {
  AutomationWorkspaceProvenanceRequest,
  GitPushTarget,
  GitWorktreeInfo,
  WorkspaceLinkedItem,
  WorkspaceAttachment,
  WorkspaceStatus,
  Worktree
} from './types'
import type { WorkspaceLineage, WorktreeLineage, WorktreeLineageWarning } from './lineage-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './launch-types'
import type {
  PreparedCheckoutMissReason,
  PreparedCheckoutOrigin,
  PreparedCheckoutReset,
  WorktreeCreateExecutionHost
} from './create-timing-vocabulary'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  WorktreeBaseStatusEvent
} from './base-ref-drift-types'

export type {
  PreparedCheckoutMissReason,
  PreparedCheckoutOrigin,
  PreparedCheckoutReset,
  WorktreeCreateExecutionHost
}

export type SetupDecision = 'inherit' | 'run' | 'skip'

export type WorktreeCreateTimingPhase = {
  phase: string
  startedAtMs: number
  durationMs: number
}

/** Prepared-checkout claim/reset evidence; hits also retain origin, build duration and idle age. */
export type PreparedCheckoutOutcome =
  | {
      status: 'hit'
      reset: PreparedCheckoutReset
      origin: PreparedCheckoutOrigin
      buildMs: number
      idleMs: number
    }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

export type WorktreeCreateTiming = {
  totalDurationMs: number
  phases: WorktreeCreateTimingPhase[]
  preparedCheckout?: PreparedCheckoutOutcome
  executionHost?: WorktreeCreateExecutionHost
  /** Worktrees Git listed after the create, main checkout included; absent when the listing failed. */
  worktreeCount?: number
}

export type CreateSparseCheckoutRequest = {
  directories: string[]
  /** Retain preset identity only for an unedited saved directory list; persisted to WorktreeMeta for display. */
  presetId?: string
}

/** A user-saved per-repo sparse directory list reused by the create composer. */
export type SparsePreset = {
  id: string
  repoId: string
  name: string
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type CreateWorktreeArgs = {
  repoId: string
  name: string
  /** Retire only generator-chosen names. User-typed pool names remain reusable; omitted callers retain legacy behavior. */
  nameWasGenerated?: boolean
  /** Readable label stored separately from the git-safe branch/path seed, e.g. a linked artifact’s title. */
  displayName?: string
  /** Distinguishes user labels from generated artifact titles at creation time. */
  displayNameKind?: 'generated' | 'user'
  baseBranch?: string
  /** Source Control compare target when it differs from the checkout start point. */
  compareBaseRef?: string
  /** Existing local branches may contain slashes that the filesystem-safe worktree name cannot. */
  branchNameOverride?: string
  /** Only an explicit existing-branch pick opts out of new-branch allocation. */
  branchIntent?: 'open-existing'
  setupDecision?: SetupDecision
  /** Per-create choice; omitted callers use the execution host's saved default. */
  setupOnly?: boolean
  sparseCheckout?: CreateSparseCheckoutRequest
  linkedIssue?: number
  linkedPR?: number
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedGitLabIssue?: number
  linkedGitLabMR?: number
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedItems?: WorkspaceAttachment[]
  linkedTaskSourceContext?: TaskSourceContext | null
  pushTarget?: GitPushTarget
  workspaceStatus?: WorkspaceStatus
  manualOrder?: number
  /** Parent workspace for in-app creates launched from a folder workspace. */
  parentWorkspace?: WorkspaceKey
  /** Agent selected in the create surface. Omitted for blank-shell creates. */
  createdWithAgent?: TuiAgent
  /** Await a first-agent-message branch/title rename for this generated branch. */
  pendingFirstAgentMessageRename?: boolean
  /** Creation-surface telemetry. Unknown surfaces emit "unknown" to expose coverage gaps; older callers may omit it and default at IPC. */
  telemetrySource?: WorkspaceSource
  /** Optionally spawn the first terminal as soon as registration finishes. */
  startup?: WorktreeStartupLaunch
  /** Correlate concurrent background creates with renderer progress; synchronous callers may omit it. */
  creationId?: string
  /** Authorizes the host to mint system-owned automation provenance. */
  automationProvenanceRequest?: AutomationWorkspaceProvenanceRequest
}

export type WorktreeCheckoutProgress = {
  percent: number
  completed: number
  total: number
}

/** Progress payload: checkout accompanies creating; null means Git finished writing files. */
export type CreateWorktreeProgressEvent = {
  creationId?: string
  phase: 'fetching' | 'creating'
  checkout?: WorktreeCheckoutProgress | null
  /** Local creates name the checkout before Git publishes it. */
  worktreeId?: string
}

export type AdoptProvisionedRootArgs = CreateWorktreeArgs & {
  runtimeId: string
  executionHostId: ExecutionHostId
  expectedPath: string
  expectedRefHead?: string
}

export type CreateWorktreeResult = {
  /** The catalog this create produced; additive, older hosts omit it. */
  catalogVersion?: WorktreeCatalogVersion
  worktree: Worktree & {
    parentWorktreeId?: string | null
    childWorktreeIds?: string[]
    lineage?: WorktreeLineage | null
    workspaceLineage?: WorkspaceLineage | null
    git?: GitWorktreeInfo
  }
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings?: WorktreeLineageWarning[]
  setup?: WorktreeSetupLaunch
  setupReceipt?: {
    requested: 'run' | 'skip' | 'inherit'
    hookFound: boolean
    startupPolicy: 'start-immediately' | 'wait-for-setup'
    state: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminalHandle?: string
  }
  defaultTabs?: WorktreeDefaultTabsLaunch
  warning?: string
  baseFallback?: WorktreeCreateBaseFallback
  initialBaseStatus?: WorktreeBaseStatusEvent
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
  startupTerminal?: {
    spawned: boolean
    handle?: string
    tabId?: string
    paneKey?: string | null
    ptyId?: string | null
    surface?: 'visible' | 'background'
  }
  timing?: WorktreeCreateTiming
}

export type WorktreeCreateBaseFallback = {
  requestedRef: string
  localRef: string
}

export type PreservedWorktreeBranch = {
  branchName: string
  head?: string
}

export type RemoveWorktreeResult = {
  /** The catalog this removal produced; additive, older hosts omit it. */
  catalogVersion?: WorktreeCatalogVersion
  preservedBranch?: PreservedWorktreeBranch
  nestedPreservedBranches?: (PreservedWorktreeBranch & { worktreeId: string })[]
  /** Present only when an explicit waiver allowed removal despite an archive-hook failure (#19334). */
  archiveHookOverride?: ArchiveHookOverride
  /** Legacy clients receive acceptance before deletion finishes; capable clients wait for completion. */
  removing?: true
}

export type ForceDeleteWorktreeBranchResult = {
  deleted: true
}
