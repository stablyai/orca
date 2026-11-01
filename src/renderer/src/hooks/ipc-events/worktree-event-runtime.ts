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
  patchWorktreeSortOrderBatch
} from '../../store/slices/worktrees/listing/worktree-sort-order-patch'
import { createWorktreeSortOrderPublicationBatch } from './worktree-sort-order-publication-batch'
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
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

const WORKTREE_RENAME_PURGE_GRACE_MS = 20_000

// Why the subscription key: it changes on reconnect, re-pair and event-stream replay invalidation.
function runtimeSortOrderFence(environmentId: string): string {
  return buildRuntimeClientEventEnvironmentKey([environmentId])
}
const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()

function getAuthoritativeDetectedWorktreeIds(state: AppState, repoId: string): Set<string> | null {
  const detected = selectDetectedWorktreesByRepo(state)[repoId]
  return detected?.authoritative === true
    ? new Set(detected.worktrees.map((worktree) => worktree.id))
    : null
}
function getVisibleWorktreeIdsForRepo(state: AppState, repoId: string): Set<string> {
  return new Set((selectWorktreesByRepo(state)[repoId] ?? []).map((worktree) => worktree.id))
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
  const sortOrderBatch = createWorktreeSortOrderPublicationBatch((patches) =>
    useAppStore.setState((s) => patchWorktreeSortOrderBatch(s, patches))
  )
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
      const { executionHostId, sortOrders, sortOrderFence } = options
      const submittedListing = selectWorktreesByRepo(useAppStore.getState())[repoId]
      // Awaiting keeps this repo's later events (renames, structural refreshes) behind the patch.
      const outcome = await sortOrderBatch.submit({
        repoId,
        hostId: executionHostId,
        sortOrders,
        isCurrent: () =>
          sortOrderFence === runtimeSortOrderFence(sortOrderOwner.environmentId) &&
          selectWorktreesByRepo(useAppStore.getState())[repoId] === submittedListing &&
          hasHostRowsForSortOrders(useAppStore.getState(), repoId, executionHostId, sortOrders)
      })
      if (outcome === 'disposed') {
        return
      }
      if (outcome === 'applied') {
        // Keep the existing retry for a host whose lineage snapshot is not fresh.
        if (!isRemoteWorktreeLineageFresh(useAppStore.getState, sortOrderOwner.environmentId)) {
          await useAppStore.getState().fetchWorktreeLineage({ executionHostId })
        }
        return
      }
    }
    const localRefreshStartedWithRuntime =
      options?.forceLocalOwner === true && isRuntimeEnvironmentActive()
    // Capture activation before migration, then rekey maps before deletion diff so renames retain state.
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
    // Diff around refetch to purge externally deleted worktree state and prevent zombie PTY entries.
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
    // ID changes unmount active panes; reactivate so tab reconciliation restores them immediately.
    if (renamedWasActive && renamed) {
      const renamedSelection = { ...selectionBeforeRename, worktreeId: renamed.newWorktreeId }
      // Why only if unchanged: a workspace or twin copy picked during the refresh is the user's.
      if (isWorkspaceSelected(useAppStore.getState(), renamedSelection)) {
        restoreWorkspaceSelection(useAppStore.getState(), renamedSelection)
      }
    }
    // Prune rename grace before early returns so local/non-authoritative events cannot leak entries indefinitely.
    const now = Date.now()
    for (const [id, expiry] of recentlyRenamedWorktreeIdExpiry) {
      if (expiry <= now) {
        recentlyRenamedWorktreeIdExpiry.delete(id)
      }
    }
    // Forced-local scans cannot prove runtime absence; fetch still purges local host rows, while space entries await local-only rescan.
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
      sortOrderBatch.dispose()
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
      // Local CLI IDs activate locally; remote stream activation follows its separate host route.
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
    // Canonical activation records CLI switches in back/forward history.
    activateAndRevealWorktree(worktreeId, {
      ...(setup ? { setup } : {}),
      ...(startup ? { startup } : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(providesInitialSurface ? { providesInitialSurface } : {}),
      ...(!existedBeforeFetch && existsAfterFetch ? { sidebarRevealBehavior: 'auto' } : {}),
      // Do not echo runtime-stream activation back to its host or selection can loop.
      notifyHostRuntime: false,
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {})
    })
  }

  return { worktreeChangeRefreshQueue, activateNotifiedWorktree }
}
