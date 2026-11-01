import { useEffect } from 'react'
import { useAppStore } from '../store'
import { onBrowserGuestPaintRetentionChange } from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  browserTabsNeedPaintRetention,
  browserTabsVetoGuestEviction
} from './browser-pane/host-guest/browser-guest-eviction-veto'
import {
  selectBrowserGuestEvictionWorktreeIds,
  touchBrowserGuestWorktreeRecency,
  worktreeHoldsLiveBrowserGuests
} from './browser-pane/host-guest/browser-guest-worktree-retention'
import { installBrowserPageDownloadActivityTracking } from './browser-pane/navigate/browser-page-download-activity'
import { hasLiveBrowserGuest } from './browser-pane/host-guest/webview-registry'
import { destroyWorktreeBrowserGuests } from '../store/slices/browser-webview-cleanup'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function useTerminalBrowserRetention(
  controller: Pick<
    TerminalParkingFoundation,
    | 'browserGuestRetentionBudgetEnabled'
    | 'browserGuestRetentionRevision'
    | 'browserGuestWorktreeRecencyRef'
    | 'mountedWorktreeIdsRef'
    | 'renderedActiveWorktreeId'
    | 'setBrowserGuestRetentionRevision'
    | 'workspaceSurfaceIds'
    | 'workspaceSurfaceIdSet'
  >
): void {
  const {
    browserGuestRetentionBudgetEnabled,
    browserGuestRetentionRevision,
    browserGuestWorktreeRecencyRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    setBrowserGuestRetentionRevision,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller

  useEffect(() => {
    const invalidateRetention = (): void => {
      setBrowserGuestRetentionRevision((revision) => revision + 1)
    }
    const removeDownloadTracking = installBrowserPageDownloadActivityTracking(invalidateRetention)
    const removePaintRetentionTracking = onBrowserGuestPaintRetentionChange(invalidateRetention)
    return () => {
      removeDownloadTracking()
      removePaintRetentionTracking()
    }
  }, [setBrowserGuestRetentionRevision])

  useEffect(() => {
    const recency = browserGuestWorktreeRecencyRef.current
    const state = useAppStore.getState()
    // A hidden worktree an agent or phone just used counts as recent; otherwise it sorts last and is evicted as soon as its claim lapses.
    for (const worktreeId of workspaceSurfaceIds) {
      if (browserTabsNeedPaintRetention(state.browserTabsByWorktree[worktreeId] ?? [])) {
        touchBrowserGuestWorktreeRecency(recency, worktreeId)
      }
    }
    if (!renderedActiveWorktreeId) {
      return
    }
    touchBrowserGuestWorktreeRecency(recency, renderedActiveWorktreeId)
    for (let index = recency.length - 1; index >= 0; index--) {
      if (!workspaceSurfaceIdSet.has(recency[index])) {
        recency.splice(index, 1)
      }
    }
    if (!browserGuestRetentionBudgetEnabled) {
      return
    }
    const recencyIds = new Set(recency)
    const orderedWorktreeIds = [
      ...recency,
      ...workspaceSurfaceIds.filter((id) => !recencyIds.has(id))
    ]
    const evictedWorktreeIds = selectBrowserGuestEvictionWorktreeIds({
      orderedWorktreeIds,
      activeWorktreeId: renderedActiveWorktreeId,
      isRetained: (worktreeId) => mountedWorktreeIdsRef.current.has(worktreeId),
      holdsLiveGuests: (worktreeId) =>
        worktreeHoldsLiveBrowserGuests(
          state.browserTabsByWorktree[worktreeId] ?? [],
          state.browserPagesByWorkspace,
          hasLiveBrowserGuest
        ),
      // Guest destruction must honor every paint-retention signal, including remote viewers, and active downloads just like the overlay.
      isEvictable: (worktreeId) =>
        !browserTabsVetoGuestEviction(state.browserTabsByWorktree[worktreeId] ?? [])
    })
    for (const worktreeId of evictedWorktreeIds) {
      destroyWorktreeBrowserGuests(
        state.browserTabsByWorktree,
        state.browserPagesByWorkspace,
        worktreeId
      )
    }
  }, [
    browserGuestWorktreeRecencyRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet,
    browserGuestRetentionBudgetEnabled,
    browserGuestRetentionRevision
  ])
}
