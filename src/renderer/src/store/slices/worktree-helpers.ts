import type {
  CreateWorktreeResult,
  CreateWorktreeArgs,
  CreateSparseCheckoutRequest,
  DetectedWorktree,
  DetectedWorktreeListResult,
  ForceDeleteWorktreeBranchResult,
  GitPushTarget,
  RemoveWorktreeResult,
  SetupDecision,
  TuiAgent,
  WorkspaceCreateTelemetrySource,
  WorkspaceStatus,
  WorkspaceLineage,
  WorktreeStartupLaunch,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeLineage,
  WorktreeRemoteBranchConflictEvent,
  WorktreeMeta,
  WorkspaceKey
} from '../../../../shared/types'
import type { WorktreeForceDeleteReason } from '../../../../shared/worktree-removal'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'
import type {
  PendingWorktreeCreation,
  WorktreeCreationPhase
} from '@/lib/pending-worktree-creation'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
export { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

export type WorktreeDeleteState = {
  isDeleting: boolean
  phase?: 'deleting' | 'queued'
  error: string | null
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
  lockReason?: string | null
}

export type WorktreeMetaUpdateGuard = (worktree: Worktree | DetectedWorktree | undefined) => boolean

export type WorktreeMetaUpdateOptions = {
  shouldApply?: WorktreeMetaUpdateGuard
  /** Skip the automatic review refetch when the caller owns an equivalent refresh. */
  suppressHostedReviewRefresh?: boolean
}

export type WorktreeRenameRequest = {
  worktreeId: string
  rowKey?: string
}

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListResult>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<WorkspaceKey, WorkspaceLineage>
  activeWorktreeId: string | null
  activeWorkspaceKey: WorkspaceKey | null
  /**
   * In-flight / failed background worktree creations, keyed by a renderer
   * `creationId`. Kept separate from `worktreesByRepo` on purpose — a real
   * worktree row only exists once `git worktree add` succeeds, so faking one
   * here would ripple through git-status, the tab model, persistence, and PTY
   * spawning. Session-only; never persisted.
   */
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  /**
   * The pending creation currently filling the workspace content area (the
   * "Creating worktree…" panel). Distinct from `activeWorktreeId`, which stays
   * strictly real, so navigating to/away from a pending creation never routes a
   * fake id through `setActiveWorktree` or nav-history.
   */
  activePendingCreationId: string | null
  // Why: signals the matching worktree card's inline title editor to open. The
  // workspace.rename shortcut sets this; the card clears it on consume.
  renamingWorktreeId: WorktreeRenameRequest | null
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState>
  baseStatusByWorktreeId: Record<string, WorktreeBaseStatusEvent>
  remoteBranchConflictByWorktreeId: Record<string, WorktreeRemoteBranchConflictEvent>
  /**
   * Monotonically increasing counter that signals when the sidebar sort order
   * should be recomputed.  Only bumped by events that represent meaningful
   * external changes (worktree add/remove, terminal activity, backend refresh)
   * — NOT by selection-triggered side-effects like clearing `isUnread`.
   */
  sortEpoch: number
  /**
   * Worktree IDs that have been activated at least once during this app
   * session. The first activation of a worktree is special: its
   * TerminalPane mounts for the first time, tabs reattach or fresh-spawn
   * their PTYs, and the resulting `updateTabPtyId`/`clearTabPtyId` calls
   * are all side-effects of the click — not real activity. On first
   * activation we tag every terminal tab with `pendingActivationSpawn` so
   * the bump is suppressed. Split-layout tabs may carry a numeric count so
   * every click-driven pane remount is suppressed. After the first activation
   * we do NOT re-tag, so subsequent events on the worktree (codex restart,
   * new pane spawn, agent output) count normally. Session-only; never persisted.
   */
  everActivatedWorktreeIds: Set<string>
  /**
   * Persisted focus-recency timestamp per worktree, used as the primary
   * ordering signal for Cmd+J's empty-query Worktrees section. Stamped by
   * `markWorktreeVisited` from user-initiated activations
   * (activateAndRevealWorktree), NOT from background activity events or raw
   * `setActiveWorktree` calls. See docs/cmd-j-empty-query-ordering.md.
   */
  lastVisitedAtByWorktreeId: Record<string, number>
  /**
   * Guards the one-shot hydration-time purge in `fetchAllWorktrees`. Set to
   * `true` only after the first launch where every repo's `worktrees.list` IPC
   * call succeeded AND at least one repo returned a non-empty result — at that
   * moment the renderer has enough signal to treat the union of fetched ids as
   * authoritative and purge stale `tabsByWorktree` keys left behind by pre-fix
   * sessions (design §4.4). Session-only; never persisted.
   */
  hasHydratedWorktreePurge: boolean
  fetchDetectedWorktrees: (repoId: string) => Promise<DetectedWorktreeListResult | null>
  fetchWorktrees: (
    repoId: string,
    options?: { requireAuthoritative?: boolean; forceLocalOwner?: boolean }
  ) => Promise<boolean>
  fetchAllWorktrees: (options?: { hydrationPurge?: 'allow' | 'defer' }) => Promise<void>
  fetchWorktreeLineage: (options?: { forceLocalOwner?: boolean }) => Promise<void>
  updateWorktreeLineage: (
    worktreeId: string,
    args: { parentWorktreeId?: string; noParent?: boolean }
  ) => Promise<void>
  assignWorktreeParent: (worktreeId: string, args: { parentWorktreeId: string }) => Promise<void>
  createWorktree: (
    repoId: string,
    name: string,
    baseBranch?: string,
    setupDecision?: SetupDecision,
    sparseCheckout?: CreateSparseCheckoutRequest,
    /** Telemetry-only: which renderer surface initiated this create. Optional
     *  so existing callers default to `unknown`; specify when the surface
     *  matters for the activation funnel. */
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
    /** When set, correlates the backend's `createWorktree:progress` events to a
     *  renderer pending creation. Synchronous callers omit it. */
    creationId?: string,
    linkedLinearIssueWorkspaceId?: string | null,
    linkedLinearIssueOrganizationUrlKey?: string | null,
    linkedBitbucketPR?: number | null,
    linkedAzureDevOpsPR?: number | null,
    linkedGiteaPR?: number | null,
    compareBaseRef?: string,
    // Why: reserved for automation-dispatch flows so host-side provenance can
    // be minted securely; regular create callers should omit this.
    options?: { automationProvenanceRequest?: CreateWorktreeArgs['automationProvenanceRequest'] }
  ) => Promise<CreateWorktreeResult>
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
      provisioningLog?: string
    }
  ) => void
  /** Drop a pending entry, clearing the active surface if it pointed at this
   *  creation. VM cleanup is for cancellation/dismissal, not successful handoff. */
  removePendingWorktreeCreation: (creationId: string, options?: { cleanupVm?: boolean }) => void
  /** Point the content panel at a pending creation (or clear it with null). */
  setActivePendingWorktreeCreation: (creationId: string | null) => void
  prefetchWorktreeCreateBase: (repoId: string, baseBranch?: string) => Promise<void>
  removeWorktree: (
    worktreeId: string,
    force?: boolean,
    // 'forget-local' drops the workspace from Orca only (no remote Git/FS work)
    // for workspaces pinned to a removed/disconnected SSH host. Reuses the same
    // renderer-side teardown/purge as a normal remove.
    options?: {
      mode?: 'remove' | 'forget-local'
      suppressPreservedBranchToast?: boolean
    }
  ) => Promise<({ ok: true } & RemoveWorktreeResult) | { ok: false; error: string }>
  markWorktreesDeleting: (worktreeIds: readonly string[]) => void
  markWorktreesQueuedForDeletion: (worktreeIds: readonly string[]) => void
  forceDeletePreservedBranch: (
    worktreeId: string,
    branchName: string,
    expectedHead: string
  ) => Promise<({ ok: true } & ForceDeleteWorktreeBranchResult) | { ok: false; error: string }>
  clearWorktreeDeleteState: (worktreeId: string) => void
  updateWorktreeMeta: (
    worktreeId: string,
    updates: Partial<WorktreeMeta>,
    options?: WorktreeMetaUpdateOptions
  ) => Promise<void>
  ensureHostedReviewPushTarget: (worktreeId: string) => Promise<void>
  updateWorktreesMeta: (
    updatesByWorktreeId: ReadonlyMap<string, Partial<WorktreeMeta>>
  ) => Promise<void>
  /**
   * Pin/unpin worktrees, then reveal the first changed one. The reveal keeps
   * the shortcut action visible even though pinned worktrees also remain in
   * their normal sidebar groups.
   */
  setWorktreesPinnedAndReveal: (worktreeIds: readonly string[], isPinned: boolean) => void
  markWorktreeUnread: (worktreeId: string) => void
  observeTerminalGitHubPullRequestLink: (worktreeId: string, link: TerminalGitHubPRLink) => void
  /** Clear the worktree's unread dot. Called on user interaction with any
   *  terminal pane inside the worktree (keystroke, click) — matches
   *  ghostty's "show until interact" model. Persists isUnread=false. */
  clearWorktreeUnread: (worktreeId: string) => void
  bumpWorktreeActivity: (worktreeId: string) => void
  /**
   * Monotonic stamp of the focus-recency timestamp for a worktree. No-op if
   * the supplied (or current) timestamp is not strictly greater than the
   * stored value. Called from user-initiated activations only. See
   * docs/cmd-j-empty-query-ordering.md.
   */
  markWorktreeVisited: (worktreeId: string, visitedAt?: number) => void
  /**
   * Drop `lastVisitedAtByWorktreeId` entries whose worktree IDs no longer
   * exist. Must be called AFTER worktree hydration completes — repos load
   * async, so pruning on raw rehydrate would nuke timestamps for worktrees
   * whose repo hasn't yet hydrated.
   */
  pruneLastVisitedTimestamps: () => void
  /**
   * One-shot migration fixup: if the active worktree has no stored
   * focus-recency timestamp after session hydration, seed it with the
   * current time. Different semantics from `markWorktreeVisited` — this
   * only fills in a missing entry on first load, it does not record a
   * fresh visit.
   */
  seedActiveWorktreeLastVisitedIfMissing: () => void
  setActiveWorktree: (worktreeId: string | null) => void
  /**
   * Health-driven remount of one terminal tab: bumps the tab's generation so
   * TerminalPane unmounts, detaches (preserving a live PTY), and remounts with
   * a fresh xterm that reattaches and replays. Used by terminal-pane-recovery
   * when a pane's write pipeline is certified dead or its input is
   * undeliverable while the PTY is alive. Returns false when the tab is gone.
   */
  remountTerminalTabForRecovery: (tabId: string) => boolean
  setActiveFolderWorkspace: (folderWorkspaceId: string) => void
  setRenamingWorktreeId: (request: string | WorktreeRenameRequest | null) => void
  allWorktrees: () => Worktree[]
  getKnownWorktreeById: (worktreeId: string) => Worktree | DetectedWorktree | undefined
  /**
   * Wipes every terminal- and worktree-scoped map entry for each given id.
   * Called by the `worktrees:changed` listener on server-side deletions and
   * one-shot at hydration time. See design §4.4.
   */
  purgeWorktreeTerminalState: (worktreeIds: string[]) => void
  /**
   * Retires every client-store row (repos, project host setups, worktree +
   * detected-worktree rows, and their tab/PTY/browser/editor cascade) owned by a
   * runtime host whose environment id was just removed from the saved list.
   * Scoped to the removal diff so a serving instance's locally-persisted
   * runtime-stamped repos — whose env id was never saved here — are never torn
   * down. No-op when the removed set is empty or nothing matched (#8881).
   */
  purgeStaleRuntimeHostState: (removedEnvironmentIds: Iterable<string>) => void
  /**
   * Re-key every worktree-scoped map + pointer from `oldWorktreeId` to
   * `newWorktreeId` after a folder rename changed the worktree's path-derived id.
   * The inverse of purge: move state instead of dropping it, so the live worktree
   * keeps its tabs, terminals, and selections. No-op when the ids match.
   */
  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
  updateWorktreeBaseStatus: (event: WorktreeBaseStatusEvent) => void
  updateWorktreeRemoteBranchConflict: (event: WorktreeRemoteBranchConflictEvent) => void
}

export function findWorktreeById(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string
): Worktree | undefined {
  for (const worktrees of Object.values(worktreesByRepo)) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match
    }
  }

  return undefined
}

export function applyWorktreeUpdates(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const worktrees = worktreesByRepo[repoId]
  if (!worktrees) {
    return worktreesByRepo
  }

  let changed = false
  const nextWorktrees = worktrees.map((worktree) => {
    if (worktree.id !== worktreeId) {
      return worktree
    }

    changed = true
    return { ...worktree, ...updates }
  })
  if (!changed) {
    return worktreesByRepo
  }

  return { ...worktreesByRepo, [repoId]: nextWorktrees }
}
