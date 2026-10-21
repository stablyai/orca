import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { AppState } from '../../store/types'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeSortOrderUpdate } from '../../../../shared/worktree/sort-order-update'
import {
  hasHostRowsForSortOrders,
  patchWorktreeSortOrders
} from '../../store/slices/worktrees/listing/worktree-sort-order-patch'
import { buildRuntimeClientEventEnvironmentKey } from './runtime-environment-subscription-selection'
import { useAppStore } from '../../store'
import {
  captureWorkspaceSelection,
  isWorkspaceSelected,
  restoreWorkspaceSelection
} from '@/lib/active-workspace-host'
import {
  invalidateRemoteWorktreeLineage,
  isRemoteWorktreeLineageFresh
} from '../../store/slices/worktrees/metadata/worktree-lineage-readiness'
import {
  createWorktreeChangeRefreshQueue,
  type WorktreeChangeRefreshQueue
} from '../worktree-change-refresh-queue'

const WORKTREE_RENAME_PURGE_GRACE_MS = 20_000

// Why the subscription key: it changes on reconnect, re-pair and event-stream replay invalidation.
function runtimeSortOrderFence(environmentId: string): string {
  return buildRuntimeClientEventEnvironmentKey([environmentId])
}
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

type WorktreeEventActivationOptions = {
  allowRuntimeEnvironment: boolean
  executionHostId?: ExecutionHostId
  isCurrent?: () => boolean
}

export type WorktreeEventRuntime = {
  worktreeChangeRefreshQueue: WorktreeChangeRefreshQueue
  activateNotifiedWorktree: (
    event: Extract<RuntimeClientEvent, { type: 'activateWorktree' }>,
    options: WorktreeEventActivationOptions
  ) => Promise<void>
}

export function createWorktreeEventRuntime(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): WorktreeEventRuntime {
  const handleWorktreesChanged = async (
    repoId: string,
    renamed?: { oldWorktreeId: string; newWorktreeId: string },
    options?: {
      forceLocalOwner?: boolean
      executionHostId?: ExecutionHostId
      sortOrderOnly?: boolean
      sortOrders?: WorktreeSortOrderUpdate[]
      sortOrderFence?: string
    }
  ): Promise<void> => {
    const sortOrderOwner = parseExecutionHostId(options?.executionHostId)
    if (
      options?.sortOrderOnly === true &&
      options.sortOrders &&
      options.executionHostId &&
      sortOrderOwner?.kind === 'runtime' &&
      options.sortOrderFence === runtimeSortOrderFence(sortOrderOwner.environmentId) &&
      !renamed &&
      !options.forceLocalOwner &&
      hasHostRowsForSortOrders(
        useAppStore.getState(),
        repoId,
        options.executionHostId,
        options.sortOrders
      )
    ) {
      // Why: the host published the saved values, so refetching the repo would only re-download them (#27268).
      const { executionHostId, sortOrders } = options
      useAppStore.setState((s) => patchWorktreeSortOrders(s, repoId, executionHostId, sortOrders))
      // Keep the existing retry for a host whose lineage snapshot is not fresh.
      if (!isRemoteWorktreeLineageFresh(useAppStore.getState, sortOrderOwner.environmentId)) {
        await useAppStore.getState().fetchWorktreeLineage({ executionHostId })
      }
      return
    }
    const localRefreshStartedWithRuntime =
      options?.forceLocalOwner === true && isRuntimeEnvironmentActive()
    // Why: capture active-ness before migration moves the pointer; re-key maps before the diff so a rename isn't a deletion.
    const renamedWasActive =
      renamed != null && useAppStore.getState().activeWorktreeId === renamed.oldWorktreeId
    const selectionBeforeRename = captureWorkspaceSelection(useAppStore.getState())
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
    const lineageOwner = parseExecutionHostId(options?.executionHostId)
    if (
      options?.sortOrderOnly !== true ||
      lineageOwner?.kind !== 'runtime' ||
      renamed ||
      options.forceLocalOwner ||
      !isRemoteWorktreeLineageFresh(useAppStore.getState, lineageOwner.environmentId)
    ) {
      await useAppStore
        .getState()
        .fetchWorktreeLineage(
          options?.forceLocalOwner
            ? { forceLocalOwner: true }
            : options?.executionHostId
              ? { executionHostId: options.executionHostId }
              : undefined
        )
    }
    // Why: an id change unmounts the active pane; re-activate so the tab reconciles, else it vanishes until re-select.
    if (renamedWasActive && renamed) {
      const renamedSelection = { ...selectionBeforeRename, worktreeId: renamed.newWorktreeId }
      // Why only if unchanged: a workspace or twin copy picked during the refresh is the user's.
      if (isWorkspaceSelected(useAppStore.getState(), renamedSelection)) {
        restoreWorkspaceSelection(useAppStore.getState(), renamedSelection)
      }
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
        purgeHostId ? removed.map((id) => hostWorktreeTarget({ id, hostId: purgeHostId })) : removed
      )
      afterState.removeWorkspaceSpaceWorktrees(removed)
    }
  }
  const refreshQueue = createWorktreeChangeRefreshQueue(handleWorktreesChanged)
  let disposed = false
  const worktreeChangeRefreshQueue: WorktreeChangeRefreshQueue = {
    dispose() {
      disposed = true
      refreshQueue.dispose()
    },
    enqueue(event) {
      if (disposed) {
        return
      }
      const owner = parseExecutionHostId(event.executionHostId)
      if (owner?.kind === 'runtime' && (event.sortOrderOnly !== true || event.renamed)) {
        invalidateRemoteWorktreeLineage(useAppStore.getState, owner.environmentId)
      }
      refreshQueue.enqueue(
        event.sortOrders && owner?.kind === 'runtime'
          ? { ...event, sortOrderFence: runtimeSortOrderFence(owner.environmentId) }
          : event
      )
    }
  }
  unsubs.push(worktreeChangeRefreshQueue.dispose)

  const activateNotifiedWorktree = async (
    {
      repoId,
      worktreeId,
      setup,
      startup,
      defaultTabs,
      providesInitialSurface
    }: Extract<RuntimeClientEvent, { type: 'activateWorktree' }>,
    options: WorktreeEventActivationOptions
  ): Promise<void> => {
    if (options.isCurrent?.() === false) {
      return
    }
    if (!options.allowRuntimeEnvironment && isRuntimeEnvironmentActive()) {
      // Why: local CLI worktree events carry local ids; runtime activation comes via the remote stream, allowed separately.
      return
    }
    const existedBeforeFetch = Boolean(
      useAppStore.getState().getKnownWorktreeById(worktreeId, options.executionHostId)
    )
    // Why: fetch first so activation can resolve the CLI-created worktree; it arrived from main, not yet in renderer state.
    await (options.executionHostId
      ? useAppStore.getState().fetchWorktrees(repoId, { executionHostId: options.executionHostId })
      : useAppStore.getState().fetchWorktrees(repoId))
    // A connection or bridge replacement during discovery revokes this navigation.
    if (options.isCurrent?.() === false) {
      return
    }
    const existsAfterFetch = Boolean(
      useAppStore.getState().getKnownWorktreeById(worktreeId, options.executionHostId)
    )
    // Why: use the canonical activation path so the CLI switch records a back/forward visit, or the nav buttons ignore it.
    activateAndRevealWorktree(worktreeId, {
      ...(setup ? { setup } : {}),
      ...(startup ? { startup } : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(providesInitialSurface ? { providesInitialSurface } : {}),
      ...(!existedBeforeFetch && existsAfterFetch ? { sidebarRevealBehavior: 'auto' } : {}),
      // Why: this activation came from the host runtime stream; echoing it back can create a selection loop.
      notifyHostRuntime: false,
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {})
    })
  }

  return { worktreeChangeRefreshQueue, activateNotifiedWorktree }
}
