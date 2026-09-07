import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import {
  createWorktreeChangeRefreshQueue,
  type WorktreeChangeRefreshQueue
} from '../worktree-change-refresh-queue'

const WORKTREE_RENAME_PURGE_GRACE_MS = 20_000
const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()

function getAuthoritativeDetectedWorktreeIds(state: AppState, repoId: string): Set<string> | null {
  const detected = state.detectedWorktreesByRepo[repoId]
  return detected?.authoritative === true
    ? new Set(detected.worktrees.map((worktree) => worktree.id))
    : null
}
function getVisibleWorktreeIdsForRepo(state: AppState, repoId: string): Set<string> {
  return new Set((state.worktreesByRepo[repoId] ?? []).map((worktree) => worktree.id))
}

export type WorktreeEventRuntime = {
  worktreeChangeRefreshQueue: WorktreeChangeRefreshQueue
  activateNotifiedWorktree: (
    event: Extract<RuntimeClientEvent, { type: 'activateWorktree' }>,
    options: { allowRuntimeEnvironment: boolean }
  ) => Promise<void>
}

export function createWorktreeEventRuntime(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): WorktreeEventRuntime {
  const handleWorktreesChanged = async (
    repoId: string,
    renamed?: { oldWorktreeId: string; newWorktreeId: string },
    options?: { forceLocalOwner?: boolean; executionHostId?: ExecutionHostId }
  ): Promise<void> => {
    const localRefreshStartedWithRuntime =
      options?.forceLocalOwner === true && isRuntimeEnvironmentActive()
    // Why: capture active-ness before migration moves the pointer; re-key maps before the diff so a rename isn't a deletion.
    const renamedWasActive =
      renamed != null && useAppStore.getState().activeWorktreeId === renamed.oldWorktreeId
    if (renamed) {
      // Shield both ids from the deletion diff across the rename's event burst — the worktree list lags the on-disk move.
      const expiry = Date.now() + WORKTREE_RENAME_PURGE_GRACE_MS
      recentlyRenamedWorktreeIdExpiry.set(renamed.oldWorktreeId, expiry)
      recentlyRenamedWorktreeIdExpiry.set(renamed.newWorktreeId, expiry)
      useAppStore.getState().migrateWorktreeIdentity(renamed.oldWorktreeId, renamed.newWorktreeId)
    }
    // Why: diff before/after fetch to catch out-of-band deletions and purge worktree state, else zombie ptyId entries leak (design §2c, §4.4).
    const state = useAppStore.getState()
    const before =
      getAuthoritativeDetectedWorktreeIds(state, repoId) ??
      getVisibleWorktreeIdsForRepo(state, repoId)
    await state.fetchWorktrees(
      repoId,
      options?.forceLocalOwner
        ? { forceLocalOwner: true }
        : options?.executionHostId
          ? {
              executionHostId: options.executionHostId,
              suppressRemoteLineageRefresh: true
            }
          : undefined
    )
    await useAppStore
      .getState()
      .fetchWorktreeLineage(
        options?.forceLocalOwner
          ? { forceLocalOwner: true }
          : options?.executionHostId
            ? { executionHostId: options.executionHostId }
            : undefined
      )
    // Why: an id change unmounts the active pane; re-activate so the tab reconciles, else it vanishes until re-select.
    if (renamedWasActive && renamed) {
      useAppStore.getState().setActiveWorktree(renamed.newWorktreeId)
    }
    // Sweep expired rename-grace entries before any early return, else forced-local
    // (or non-authoritative) events let the map grow for the session.
    const now = Date.now()
    for (const [id, expiry] of recentlyRenamedWorktreeIdExpiry) {
      if (expiry <= now) {
        recentlyRenamedWorktreeIdExpiry.delete(id)
      }
    }
    // Why: the deletion diff below is repo-wide, but a forced-local scan overlapping
    // a runtime cannot prove remote absence (legacy runtime rows may lack hostId).
    // fetchWorktrees still purges removed local rows host-scoped; accepted gap: the
    // workspace-space entry survives until the next local-only rescan.
    if (
      options?.forceLocalOwner &&
      (localRefreshStartedWithRuntime || isRuntimeEnvironmentActive())
    ) {
      return
    }
    const afterState = useAppStore.getState()
    const after = getAuthoritativeDetectedWorktreeIds(afterState, repoId)
    if (!after) {
      return
    }
    const removed: string[] = []
    for (const id of before) {
      if (after.has(id)) {
        continue
      }
      // A recently renamed worktree's old/new id isn't a deletion — its state moved to the new id; the list just lags.
      const graceExpiry = recentlyRenamedWorktreeIdExpiry.get(id)
      if (graceExpiry != null && graceExpiry > now) {
        continue
      }
      removed.push(id)
    }
    if (removed.length > 0) {
      console.warn(
        `[worktree-purge] diff-based purge removing state for ${removed.length} worktree(s):`,
        removed
      )
      const purgeHostId =
        options?.executionHostId ??
        // A forced-local refresh owns only the local host's panes.
        (options?.forceLocalOwner ? LOCAL_EXECUTION_HOST_ID : undefined)
      afterState.purgeWorktreeTerminalState(
        purgeHostId ? removed.map((id) => ({ id, hostId: purgeHostId })) : removed
      )
      afterState.removeWorkspaceSpaceWorktrees(removed)
    }
  }
  const worktreeChangeRefreshQueue = createWorktreeChangeRefreshQueue(handleWorktreesChanged)
  unsubs.push(worktreeChangeRefreshQueue.dispose)

  const activateNotifiedWorktree = async (
    {
      repoId,
      worktreeId,
      setup,
      startup,
      defaultTabs
    }: Extract<RuntimeClientEvent, { type: 'activateWorktree' }>,
    options: { allowRuntimeEnvironment: boolean }
  ): Promise<void> => {
    if (!options.allowRuntimeEnvironment && isRuntimeEnvironmentActive()) {
      // Why: local CLI worktree events carry local ids; runtime activation comes via the remote stream, allowed separately.
      return
    }
    const existedBeforeFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
    // Why: fetch first so activation can resolve the CLI-created worktree; it arrived from main, not yet in renderer state.
    await useAppStore.getState().fetchWorktrees(repoId)
    const existsAfterFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
    // Why: use the canonical activation path so the CLI switch records a back/forward visit, or the nav buttons ignore it.
    activateAndRevealWorktree(worktreeId, {
      ...(setup ? { setup } : {}),
      ...(startup ? { startup } : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(!existedBeforeFetch && existsAfterFetch ? { sidebarRevealBehavior: 'auto' } : {}),
      // Why: this activation came from the host runtime stream; echoing it back can create a selection loop.
      notifyHostRuntime: false
    })
  }

  return { worktreeChangeRefreshQueue, activateNotifiedWorktree }
}
