import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { restoreExpandedLayoutFrom } from './expand-collapse'
import { captureParkedTerminalPaneCandidates } from './terminal-parked-tab-watchers'
import { shouldDetachPaneTransportOnUnmount } from './terminal-pane-lifecycle-primitives'
import { cancelQueuedTerminalPaneSplitRequests } from './terminal-pane-split-request-routing'
import {
  clearDeferredSplitPaneHandoff,
  discardDeferredSplitPaneHandoffsForTab,
  releaseDeferredSplitPaneHandoff,
  type DeferredSplitPaneHandoffHandle
} from './deferred-split-pane-handoff'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'
import { e2eConfig } from '@/lib/e2e-config'
import { useAppStore } from '@/store'

export function cleanupTerminalPaneMount(args: {
  manager: PaneManager
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  deferredSplitHandoffs: Map<number, DeferredSplitPaneHandoffHandle>
  expandedStyleSnapshots: Map<HTMLElement, { display: string; flex: string }>
  unregisterRuntimeTab: () => void
  cancelResize: () => void
}): void {
  const {
    manager,
    deps,
    refs,
    deferredSplitHandoffs,
    expandedStyleSnapshots,
    unregisterRuntimeTab,
    cancelResize
  } = args
  const { tabId, worktreeId, managerRef, paneTransportsRef, panePtyBindingsRef } = deps
  const currentStore = useAppStore.getState()
  const currentWorktreeTabs = currentStore.tabsByWorktree[worktreeId]
  // Queued split cancellation stays worktree-scoped: a tab that merely moved
  // buckets must still cancel this worktree's queue.
  const tabRemainsInWorktree = Boolean(
    currentWorktreeTabs?.some((candidate) => candidate.id === tabId)
  )
  if (!tabRemainsInWorktree) {
    cancelQueuedTerminalPaneSplitRequests(tabId, worktreeId)
  }
  // Handoff retention is deliberately broader: a tab move removes the old
  // worktree bucket before the replacement surface mounts, so use the shared
  // global ownership check to let an ID-less deferred split survive a rehome.
  const tabStillExists = isTerminalTabPresent(currentStore, tabId)
  unregisterRuntimeTab()
  cancelResize()
  restoreExpandedLayoutFrom(expandedStyleSnapshots)
  disposeAll(refs.linkProviderDisposablesRef.current)
  disposeAll(refs.terminalHandleLinkDisposablesRef.current)
  disposeAll(refs.linkifierClickPrimingDisposablesRef.current)
  for (const gesture of refs.linkPointerGesturesRef.current.values()) {
    gesture.dispose()
  }
  refs.linkPointerGesturesRef.current.clear()
  disposeAll(refs.fileLinkClickFallbackDisposablesRef.current)
  disposeAll(refs.httpLinkClickFallbackDisposablesRef.current)
  disposeAll(refs.selectionDisposablesRef.current)
  for (const timer of refs.selectionCaptureTimersRef.current.values()) {
    window.clearTimeout(timer)
  }
  refs.selectionCaptureTimersRef.current.clear()
  disposeAll(refs.mouseHideDisposablesRef.current)
  disposeAll(refs.imeCompositionDisposablesRef.current)
  disposeAll(refs.imeNativeTextForwarderDisposablesRef.current)

  captureParkedTerminalPaneCandidates(
    tabId,
    worktreeId,
    manager.getPanes().map((pane) => {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const binding = panePtyBindingsRef.current.get(pane.id) as
        | { isUntouchedFreshSpawnPty?: (candidate: string) => boolean }
        | undefined
      return {
        ptyId,
        paneId: pane.id,
        leafId: pane.leafId,
        drivesTabTitle: manager.getActivePane()?.id === pane.id,
        untouchedFreshSpawn: ptyId !== null && (binding?.isUntouchedFreshSpawnPty?.(ptyId) ?? false)
      }
    })
  )
  for (const [paneId, transport] of paneTransportsRef.current) {
    const ptyId = transport.getPtyId()
    const deferredSplitHandoff = deferredSplitHandoffs.get(paneId)
    if (deferredSplitHandoff) {
      if (tabStillExists && !ptyId) {
        // Keep only the transient launch record; the old transport and
        // xterm are still disposable during a whole-tab remount.
        releaseDeferredSplitPaneHandoff(deferredSplitHandoff)
      } else {
        clearDeferredSplitPaneHandoff(deferredSplitHandoff)
      }
      deferredSplitHandoffs.delete(paneId)
    }
    if (
      shouldDetachPaneTransportOnUnmount({
        tabStillExists,
        tabId,
        ptyId,
        worktreeTabs: currentWorktreeTabs
      })
    ) {
      transport.detach?.({ preserveExitObserver: false })
    } else {
      transport.destroy?.()
    }
  }
  if (!tabStillExists) {
    // Covers a pane whose transport was removed before this cleanup (for
    // example, a close raced the effect teardown).
    discardDeferredSplitPaneHandoffsForTab(tabId)
  }
  for (const binding of panePtyBindingsRef.current.values()) {
    binding.dispose()
  }
  panePtyBindingsRef.current.clear()
  paneTransportsRef.current.clear()
  manager.destroy()
  managerRef.current = null
  if (e2eConfig.exposeStore && window.__paneManagers?.get(tabId) === manager) {
    window.__paneManagers.delete(tabId)
  }
  deps.setTabPaneExpanded(tabId, false)
  deps.setTabCanExpandPane(tabId, false)
}

function disposeAll(map: Map<number, { dispose: () => void }>): void {
  for (const disposable of map.values()) {
    disposable.dispose()
  }
  map.clear()
}
