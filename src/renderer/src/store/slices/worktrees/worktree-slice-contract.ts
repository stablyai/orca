import type {
  WorktreeFetchOptions,
  DirectSshWorktreeFetchOptions
} from './listing/worktree-fetch-options'
import type {
  WorktreeMetaUpdateOptions,
  WorktreeMetaBatchUpdate
} from './metadata/worktree-meta-update-options'
import type {
  WorktreeRenameRequest,
  ActiveWorktreeStateTransition
} from './session/worktree-selection-contract'

import type { WorkspaceAttachmentMutation } from '../../../../../shared/workspace-attachments/workspace-attachment-mutation'
import type { WorkspaceReferenceObservationContext } from '@/lib/workspace-attachment-observed-origin'
import type {
  CreateWorktreeCallOptions,
  CreatedWorktreeResult
} from './create/worktree-create-payload'
import type { WorktreeCatalogVersion } from '../../../../../shared/worktree/catalog-version'
import type { WorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../../shared/workspace-source'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../../../../shared/worktree/base-ref-drift-types'
import type {
  CreateSparseCheckoutRequest,
  ForceDeleteWorktreeBranchResult,
  SetupDecision
} from '../../../../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../../../../shared/worktree/launch-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../../../shared/worktree/meta-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  GitPushTarget,
  WorkspaceStatus,
  Worktree
} from '../../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../../shared/worktree/removal'
import type { TerminalGitHubPRLink } from '../../../../../shared/terminal/links/terminal-github-pr-link-detector'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { TerminalPaneRecoveryOutcome } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type {
  TerminalRecoveryRemountRequest,
  TerminalRecoveryRemountResult
} from '../../terminals/terminal-tab-recovery-ledger'
import type { RemoveWorktreeOptions } from './teardown/worktree-removal-options'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../../shared/detected-worktree-provider-contract'

import type {
  PendingWorktreeCreation,
  WorktreeCreationPhase
} from '@/lib/workspace/creation/pending-worktree-creation'

import type { WorktreeRefreshAllOptions } from './listing/worktree-refresh-options'
import type { WorktreeRefreshResult } from './listing/worktree-refresh-result'

import type { WorktreePurgeTargets } from './teardown/worktree-purge-target'

import type {
  WorktreeDeleteState,
  WorktreeDeleteStateTarget
} from './teardown/worktree-delete-state-types'

import type { RendererRemoveWorktreeResult } from './teardown/renderer-remove-worktree-result'

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListResult>
  /** Newest catalog version applied per repo and host; an older publication is never applied. */
  worktreeCatalogVersionByRepoHost: Record<string, WorktreeCatalogVersion>
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<WorkspaceKey, WorkspaceLineage>>
  /** Each store's saved cross-store parents as it keeps them, by lineage store key (OWN_LINEAGE_STORE_KEY or a paired environment id). */
  crossStoreLineageByStoreKey: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** This desktop store's installationId; undefined until its lineage list answers. */
  ownLineageInstallationId: string | undefined
  activeWorktreeId: string | null
  activeWorkspaceKey: WorkspaceKey | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  /** Session-only pending creates stay outside real worktree rows until git succeeds; fake rows would reach status, tabs, persistence and PTY spawn. */
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  /** Pending content surface, separate from real activeWorktreeId so navigation/history never receives a fake ID. */
  activePendingCreationId: string | null
  // Why: signals the matching worktree card's inline title editor to open. The
  // workspace.rename shortcut sets this; the card clears it on consume.
  renamingWorktreeId: WorktreeRenameRequest | null
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState>
  baseStatusByWorktreeId: Record<string, WorktreeBaseStatusEvent>
  remoteBranchConflictByWorktreeId: Record<string, WorktreeRemoteBranchConflictEvent>
  /** External work/activity/refresh epoch for sidebar sorting; selection side effects such as clearing unread must not advance it. */
  sortEpoch: number
  /** sortEpoch after the settle window; the sidebar sort reads this (see store/settled-sort-epoch.ts). */
  settledSortEpoch: number
  /** Bumped by sortOrder-only changes, which skip sortEpoch so live Smart can't loop on its own saves. */
  sortOrderEpoch: number
  /** Session-only first-activation set; tag click-driven PTY reattach/spawn to suppress activity bumps (counts cover split remounts). Later real work must count normally. */
  everActivatedWorktreeIds: Set<string>
  /** Persisted user-visit recency for empty-query Cmd+J; mark only through user activation, never background/raw setActiveWorktree (cmd-j-empty-query-ordering.md). */
  /** New host-qualified rows use `${host}|${worktreeId}`; legacy bare ids remain readable. */
  lastVisitedAtByWorktreeId: Record<string, number>
  /** One-shot authoritative purge after every repo detection succeeds and the union is nonempty; retire stale persisted tab keys only then (design §4.4). Session-only. */
  hasHydratedWorktreePurge: boolean
  /** Startup owns the initial all-host refresh; sidebar repo-change refreshes stay gated until it finishes. */
  startupWorktreeRefreshCompleted: boolean
  fetchDetectedWorktrees: (repoId: string) => Promise<DetectedWorktreeListResult | null>
  fetchWorktrees: {
    (
      repoId: string,
      options: DirectSshWorktreeFetchOptions
    ): Promise<HostQualifiedDetectedWorktreeResult>
    (repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  }
  fetchAllWorktrees: (options?: WorktreeRefreshAllOptions) => Promise<WorktreeRefreshResult[]>
  fetchWorktreeLineage: (options?: {
    forceLocalOwner?: boolean
    executionHostId?: ExecutionHostId
    /** Hosts whose other stores also load their cross-machine links. */
    crossStoreHostIds?: Iterable<ExecutionHostId>
  }) => Promise<void>
  /** `executionHostId` names the clicked row's host, so a same-id twin elsewhere is never the target. */
  updateWorktreeLineage: (
    worktreeId: string,
    args: { parentWorktreeId?: string; noParent?: boolean; executionHostId?: ExecutionHostId }
  ) => Promise<void>
  assignWorktreeParent: (
    worktreeId: string,
    args: { parentWorktreeId: string; executionHostId?: ExecutionHostId }
  ) => Promise<void>
  assignCrossStoreWorktreeParent: (children: readonly Worktree[], parent: Worktree) => Promise<void>
  createWorktree: (
    repoId: string,
    name: string,
    baseBranch?: string,
    setupDecision?: SetupDecision,
    sparseCheckout?: CreateSparseCheckoutRequest,
    /** Optional activation-funnel source; existing callers default to unknown. */
    telemetrySource?: WorkspaceCreateTelemetrySource,
    displayName?: string,
    linkedIssue?: number,
    linkedPR?: number,
    pushTarget?: GitPushTarget,
    createdWithAgent?: TuiAgent,
    linkedLinearIssue?: string,
    branchNameOverride?: string,
    workspaceStatus?: WorkspaceStatus,
    linkedGitLabMR?: number,
    linkedGitLabIssue?: number,
    startup?: WorktreeStartupLaunch,
    pendingFirstAgentMessageRename?: boolean,
    /** Correlates backend progress to pending creation; synchronous callers omit. */
    creationId?: string,
    linkedLinearIssueWorkspaceId?: string | null,
    linkedLinearIssueOrganizationUrlKey?: string | null,
    linkedBitbucketPR?: number | null,
    linkedAzureDevOpsPR?: number | null,
    linkedGiteaPR?: number | null,
    compareBaseRef?: string,
    options?: CreateWorktreeCallOptions
  ) => Promise<CreatedWorktreeResult>
  /** Register an in-flight background creation and make it the active surface. */
  beginPendingWorktreeCreation: (entry: PendingWorktreeCreation) => void
  /** Merge a status patch into an existing pending entry. */
  updatePendingWorktreeCreation: (
    creationId: string,
    patch: {
      phase?: WorktreeCreationPhase
      status?: 'creating' | 'error'
      startedAt?: number
      error?: string
      loaderVisible?: boolean
      request?: PendingWorktreeCreation['request']
      chatSessionOptions?: Readonly<Record<string, string>>
      provisioningLog?: string
      checkoutProgress?: PendingWorktreeCreation['checkoutProgress']
      worktreeId?: string
      heldChatMessage?: string
      heldChatAttachments?: PendingWorktreeCreation['heldChatAttachments']
      heldChatSkills?: PendingWorktreeCreation['heldChatSkills']
      chatInputHandedOff?: boolean
    }
  ) => void
  /** Drop pending/active creation; VM cleanup applies to cancellation/dismissal, never successful handoff. */
  removePendingWorktreeCreation: (creationId: string, options?: { cleanupVm?: boolean }) => void
  /** Point the content panel at a pending creation (or clear it with null). */
  setActivePendingWorktreeCreation: (creationId: string | null) => void
  prefetchWorktreeCreateBase: (repoId: string, baseBranch?: string) => Promise<void>
  /** Destructive: takes a host-qualified target because `id` alone repeats
   *  across hosts and would delete another host's checkout (STA-4343). */
  removeWorktree: (
    target: WorktreeRemovalTarget,
    force?: boolean,
    options?: RemoveWorktreeOptions
  ) => Promise<({ ok: true } & RendererRemoveWorktreeResult) | { ok: false; error: string }>
  markWorktreesDeleting: (worktrees: readonly (string | WorktreeDeleteStateTarget)[]) => void
  markWorktreesQueuedForDeletion: (
    worktrees: readonly (string | WorktreeDeleteStateTarget)[]
  ) => void
  forceDeletePreservedBranch: (
    worktreeId: string,
    branchName: string,
    expectedHead: string,
    options?: {
      suppressToast?: boolean
      hostId?: ExecutionHostId
      runtimeEnvironmentId?: string
    }
  ) => Promise<({ ok: true } & ForceDeleteWorktreeBranchResult) | { ok: false; error: string }>
  clearWorktreeDeleteState: (worktreeId: string, executionHostId?: ExecutionHostId) => void
  /** Never rejects — most callers fire-and-forget. Callers that own a surface
   *  the user is waiting on should read the result and say what went wrong. */
  updateWorktreeMeta: (
    worktreeId: string,
    updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation,
    options?: WorktreeMetaUpdateOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  ensureHostedReviewPushTarget: (worktreeId: string) => Promise<void>
  updateWorktreesMeta: (updatesByWorktreeId: readonly WorktreeMetaBatchUpdate[]) => Promise<void>
  /** Pin/unpin then reveal the first changed target so the shortcut remains visible alongside normal sidebar groups. */
  /** Each target names its copy; a host-less id two hosts publish is skipped, not guessed. */
  setWorktreesPinnedAndReveal: (
    targets: readonly Pick<Worktree, 'id' | 'hostId'>[],
    isPinned: boolean
  ) => void
  observeTerminalGitHubPullRequestLink: (
    worktreeId: string,
    link: TerminalGitHubPRLink,
    context?: WorkspaceReferenceObservationContext
  ) => void
  bumpWorktreeActivity: (worktreeId: string) => void
  /** User-activation-only recency stamp; ignore non-increasing timestamps (cmd-j-empty-query-ordering.md). */
  markWorktreeVisited: (
    worktreeId: string,
    visitedAt?: number,
    executionHostId?: ExecutionHostId
  ) => void
  /** Prune visits only after hydration; early pruning would erase entries for asynchronously loading repos. */
  pruneLastVisitedTimestamps: () => void
  /** One-shot migration seed for missing active recency after hydration; never records a fresh visit over an existing timestamp. */
  seedActiveWorktreeLastVisitedIfMissing: () => void
  setActiveWorktree: (
    worktreeId: string | null,
    executionHostId?: ExecutionHostId,
    options?: {
      stateTransition?: ActiveWorktreeStateTransition
      /** Tabs the caller just created there: their first spawn is new work, not a wake. */
      createdTabIds?: readonly string[]
    }
  ) => boolean
  /** Recovery remount detaches live PTY then reattaches/replays in fresh xterm. Update generation and row-owned admission ledger atomically; omitted request means external lifecycle remount without admission/ledger. */
  remountTerminalTabForRecovery: (
    tabId: string,
    request?: TerminalRecoveryRemountRequest
  ) => TerminalRecoveryRemountResult
  /** Record what a mounted pane observed for its recovery attempt. Ignored
   *  unless `generation` is the row's current, still-pending ledger epoch. */
  settleTerminalTabRecovery: (
    tabId: string,
    generation: number,
    outcome: Exclude<TerminalPaneRecoveryOutcome, 'pending'>
  ) => void
  setActiveFolderWorkspace: (folderWorkspaceId: string, executionHostId?: ExecutionHostId) => void
  setRenamingWorktreeId: (request: string | WorktreeRenameRequest | null) => void
  allWorktrees: () => Worktree[]
  getKnownWorktreeById: (
    worktreeId: string,
    executionHostId?: ExecutionHostId
  ) => Worktree | DetectedWorktree | undefined
  /** Purge worktree/terminal maps on server deletion and once at hydration (design §4.4). */
  purgeWorktreeTerminalState: (worktreeTargets: WorktreePurgeTargets) => void
  /** Retire removed-runtime catalog/worktree/tab/PTY/browser/editor state only from saved-list removal diff. Serving-local runtime stamps never saved here must survive; empty/unmatched diff is inert (#8881). */
  purgeStaleRuntimeHostState: (removedEnvironmentIds: Iterable<string>) => void
  /** Move worktree-scoped maps/pointers on path-derived ID rename, preserving live tabs/selection; equal IDs are inert. */
  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => void
  /** `ownerHostId` names the copy git answered for; null patches only an id no twin shares. */
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null },
    ownerHostId: ExecutionHostId | null
  ) => void
  updateWorktreeBaseStatus: (event: WorktreeBaseStatusEvent) => void
  updateWorktreeRemoteBranchConflict: (event: WorktreeRemoteBranchConflictEvent) => void
}
