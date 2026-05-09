import type {
  CreateWorktreeResult,
  CreateSparseCheckoutRequest,
  SetupDecision,
  WorkspaceCreateTelemetrySource,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent,
  WorktreeMeta
} from '../../../../shared/types'

export type WorktreeDeleteState = {
  isDeleting: boolean
  error: string | null
  canForceDelete: boolean
}

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  activeWorktreeId: string | null
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
   * the bump is suppressed. After the first activation we do NOT re-tag,
   * so subsequent events on the worktree (codex restart, new pane spawn,
   * agent output) count normally. Session-only; never persisted.
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
  fetchWorktrees: (repoId: string) => Promise<void>
  fetchAllWorktrees: () => Promise<void>
  createWorktree: (
    repoId: string,
    name: string,
    baseBranch?: string,
    setupDecision?: SetupDecision,
    sparseCheckout?: CreateSparseCheckoutRequest,
    /** Telemetry-only: which renderer surface initiated this create. Optional
     *  so existing callers default to `unknown`; specify when the surface
     *  matters for the activation funnel. */
    telemetrySource?: WorkspaceCreateTelemetrySource
  ) => Promise<CreateWorktreeResult>
  removeWorktree: (
    worktreeId: string,
    force?: boolean
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  clearWorktreeDeleteState: (worktreeId: string) => void
  updateWorktreeMeta: (worktreeId: string, updates: Partial<WorktreeMeta>) => Promise<void>
  markWorktreeUnread: (worktreeId: string) => void
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
  allWorktrees: () => Worktree[]
  /**
   * Wipes every terminal- and worktree-scoped map entry for each given id.
   * Called by the `worktrees:changed` listener on server-side deletions and
   * one-shot at hydration time. See design §4.4.
   */
  purgeWorktreeTerminalState: (worktreeIds: string[]) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string }
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
  let changed = false
  const next: Record<string, Worktree[]> = {}

  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }

      const updatedWorktree = { ...worktree, ...updates }
      repoChanged = true
      changed = true
      return updatedWorktree
    })

    next[repoId] = repoChanged ? nextWorktrees : worktrees
  }

  return changed ? next : worktreesByRepo
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const sepIdx = worktreeId.indexOf('::')
  return sepIdx === -1 ? worktreeId : worktreeId.slice(0, sepIdx)
}
