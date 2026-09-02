import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSource } from '../workspace-source'
import type { TaskSourceContext } from '../task-source-context'
import type { WorkspaceKey } from '../folder-workspace-types'
import type { TuiAgent } from '../tui-agent'
import type {
  AutomationWorkspaceProvenanceRequest,
  GitPushTarget,
  GitWorktreeInfo,
  WorkspaceLinkedItem,
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
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion,
  WorktreeBaseStatusEvent
} from './base-ref-drift-types'

export type SetupDecision = 'inherit' | 'run' | 'skip'

export type WorktreeCreateTimingPhase = {
  phase: string
  startedAtMs: number
  durationMs: number
}

/** Closed vocabulary: these values reach span attributes, so none of them may ever
 *  be derived from a branch name, a ref, or a path. */
export type PreparedCheckoutMissReason =
  | 'none_armed'
  /** Preparations exist, but none for this repo — it was never warmed, or the pool's size cap
   *  evicted it for another repo. Distinguished from `none_armed` because it is the signal that
   *  the cap is thrashing for a multi-project user. */
  | 'repo_mismatch'
  | 'base_mismatch'
  | 'retarget_too_divergent'
  /** The drift check returned no answer. Distinct from `retarget_too_divergent` because that one
   *  is the bound working as intended, while this one means a possibly cheap retarget was skipped
   *  anyway. Deliberately a mixed bucket — a blown deadline, a cancelled create, and an ordinary
   *  Git failure such as a missing ref all land here — so treat a rise as "look at why", not as a
   *  direct readout of the budget being too small. */
  | 'retarget_unverifiable'
  | 'workspace_root_mismatch'
  | 'wsl_distro_mismatch'
  | 'prepare_failed'
  | 'finalize_failed'
  | 'checkout_existing_branch'
  | 'sparse_checkout'

/** Whether a create reused a prewarmed checkout, and when it did not, which part of
 *  the claim key disagreed. `retargeted` marks a hit that had to reset the prepared
 *  checkout onto a different ref in the same base family. */
export type PreparedCheckoutOutcome =
  | { status: 'hit'; retargeted: boolean }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

export type WorktreeCreateTiming = {
  totalDurationMs: number
  phases: WorktreeCreateTimingPhase[]
  preparedCheckout?: PreparedCheckoutOutcome
}

export type CreateSparseCheckoutRequest = {
  directories: string[]
  /** Set when the directories came from a saved preset and the user did not
   *  modify them — recorded on WorktreeMeta so the worktree can show "from
   *  preset X" later. Cleared if the user edited the textarea. */
  presetId?: string
}

/** A reusable per-repo sparse directory list. Saved by the user from the
 *  composer; surfaced again the next time they create a worktree in the same
 *  repo. The MVP scope (no preset) is `presetId === undefined`. */
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
  /** True only when `name` came from Orca's creature-name generator rather than the user. Gates
   *  name retirement: a generated name is never reissued, but `Orca`, `Runner` and `Molly` are all
   *  in that pool, so a name the user typed must stay reusable. Defaults to false, which keeps
   *  CLI and automation callers on the pre-retirement behavior. */
  nameWasGenerated?: boolean
  /** Optional user-facing label to persist separately from the git-safe
   *  branch/path seed. Used when a workspace is created from a GitHub or
   *  Linear artifact whose title should remain readable in the sidebar. */
  displayName?: string
  /** Distinguishes user labels from generated artifact titles at creation time. */
  displayNameKind?: 'generated' | 'user'
  baseBranch?: string
  /** Source Control compare target when it differs from the checkout start point. */
  compareBaseRef?: string
  /** Optional git branch to create, separate from the filesystem-safe worktree
   *  name. Used when creating from an existing branch whose local branch name
   *  legitimately contains `/` while the worktree directory must not. */
  branchNameOverride?: string
  setupDecision?: SetupDecision
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
  linkedTaskSourceContext?: TaskSourceContext | null
  pushTarget?: GitPushTarget
  workspaceStatus?: WorkspaceStatus
  manualOrder?: number
  /** Parent workspace for in-app creates launched from a folder workspace. */
  parentWorkspace?: WorkspaceKey
  /** Agent selected in the create surface. Omitted for blank-shell creates. */
  createdWithAgent?: TuiAgent
  /** Set when the renderer knows this auto-generated branch should be renamed
   *  from the first agent message. */
  pendingFirstAgentMessageRename?: boolean
  /** Telemetry-only: which UI surface initiated this create. Threaded from
   *  the renderer entry point so main can emit `workspace_created` with the
   *  correct `source`. `unknown` is a valid wire value — an unrecognized
   *  surface emits `source: 'unknown'` rather than dropping the event, so
   *  dashboards surface enum-coverage gaps as a slice rather than as
   *  missing data. Optional on the type so older renderer code paths that
   *  pre-date this prop default to `unknown` at the IPC boundary instead
   *  of failing typecheck. */
  telemetrySource?: WorkspaceSource
  /** Optional startup command for callers that want the backend to spawn the
   *  first terminal as soon as the worktree is registered. */
  startup?: WorktreeStartupLaunch
  /** Correlates `createWorktree:progress` events back to a specific pending
   *  creation in the renderer, so concurrent background creates each drive
   *  their own status surface. Omitted by synchronous callers. */
  creationId?: string
  /** Authorizes the host to mint system-owned automation provenance. */
  automationProvenanceRequest?: AutomationWorkspaceProvenanceRequest
}

export type AdoptProvisionedRootArgs = CreateWorktreeArgs & {
  runtimeId: string
  executionHostId: ExecutionHostId
  expectedPath: string
  expectedRefHead?: string
}

export type CreateWorktreeResult = {
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
  preservedBranch?: PreservedWorktreeBranch
}

export type ForceDeleteWorktreeBranchResult = {
  deleted: true
}
