import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
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
  let failure: unknown
  const finish = (cleanup: () => void): void => {
    try {
      cleanup()
    } catch (error) {
      failure ??= error
    }
  }
  const currentStore = useAppStore.getState()
  const currentWorktreeTabs = currentStore.tabsByWorktree[worktreeId]
  // Cancel queued splits by original worktree even if the tab moved buckets.
  const tabRemainsInWorktree = Boolean(
    currentWorktreeTabs?.some((candidate) => candidate.id === tabId)
  )
  // Global ownership permits handoff across the bucket gap before a rehomed surface mounts, including deferred splits without PTY IDs.
  const tabStillExists = isTerminalTabPresent(currentStore, tabId)
  captureParkedTerminalPaneCandidates(
    tabId,
    worktreeId,
    manager.getPanes().map((pane) => {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const binding = panePtyBindingsRef.current.get(pane.id)
      return {
        ptyId,
        workspaceOwner: captureNotificationTransportOwner(paneTransportsRef.current.get(pane.id)),
        paneId: pane.id,
        leafId: pane.leafId,
        drivesTabTitle: manager.getActivePane()?.id === pane.id,
        untouchedFreshSpawn:
          ptyId !== null &&
          binding !== undefined &&
          'isUntouchedFreshSpawnPty' in binding &&
          typeof binding.isUntouchedFreshSpawnPty === 'function' &&
          binding.isUntouchedFreshSpawnPty(ptyId) === true
      }
    })
  )
  const bindings = [...panePtyBindingsRef.current]
  const transports = [...paneTransportsRef.current]
  for (const [id, binding] of bindings) {
    if (panePtyBindingsRef.current.get(id) === binding) {
      panePtyBindingsRef.current.delete(id)
    }
  }
  for (const [id, transport] of transports) {
    if (paneTransportsRef.current.get(id) === transport) {
      paneTransportsRef.current.delete(id)
    }
  }
  const disposables = [
    refs.linkProviderDisposablesRef.current,
    refs.terminalHandleLinkDisposablesRef.current,
    refs.linkifierClickPrimingDisposablesRef.current,
    refs.linkPointerGesturesRef.current,
    refs.fileLinkClickFallbackDisposablesRef.current,
    refs.selectionDisposablesRef.current,
    refs.nativeCopyDisposablesRef.current,
    refs.mouseHideDisposablesRef.current,
    refs.imeCompositionDisposablesRef.current,
    refs.imeNativeTextForwarderDisposablesRef.current,
    refs.httpLinkClickFallbackDisposablesRef.current,
    refs.osc52DisposablesRef.current,
    refs.osc7DisposablesRef.current
  ].flatMap((map) => {
    const captured = [...map.values()]
    map.clear()
    return captured
  })
  const timers = [...refs.selectionCaptureTimersRef.current.values()]
  refs.selectionCaptureTimersRef.current.clear()
  const handoffs = new Map(deferredSplitHandoffs)
  deferredSplitHandoffs.clear()
  if (!tabRemainsInWorktree) {
    finish(() => cancelQueuedTerminalPaneSplitRequests(tabId, worktreeId))
  }
  for (const [, binding] of bindings) {
    finish(() => binding.dispose())
  }
  for (const disposable of disposables) {
    finish(() => disposable.dispose())
  }
  for (const timer of timers) {
    window.clearTimeout(timer)
  }
  finish(unregisterRuntimeTab)
  finish(cancelResize)
  finish(() => restoreExpandedLayoutFrom(expandedStyleSnapshots))
  for (const [paneId, transport] of transports) {
    const ptyId = transport.getPtyId()
    const deferredSplitHandoff = handoffs.get(paneId)
    if (deferredSplitHandoff) {
      if (tabStillExists && !ptyId) {
        // Retain only transient launch identity across whole-tab remounts; dispose old transport/xterm.
        finish(() => releaseDeferredSplitPaneHandoff(deferredSplitHandoff))
      } else {
        finish(() => clearDeferredSplitPaneHandoff(deferredSplitHandoff))
      }
    }
    if (
      shouldDetachPaneTransportOnUnmount({
        tabStillExists,
        tabId,
        ptyId,
        worktreeTabs: currentWorktreeTabs
      })
    ) {
      finish(() => transport.detach?.({ preserveExitObserver: false }))
    } else {
      finish(() => transport.destroy?.())
    }
  }
  if (!tabStillExists) {
    // Cleanup also covers transports removed by a racing close.
    finish(() => discardDeferredSplitPaneHandoffsForTab(tabId))
  }
  finish(() => manager.destroy())
  if (managerRef.current === manager) {
    managerRef.current = null
  }
  if (e2eConfig.exposeStore && window.__paneManagers?.get(tabId) === manager) {
    window.__paneManagers.delete(tabId)
  }
  if (managerRef.current === null) {
    finish(() => deps.setTabPaneExpanded(tabId, false))
    finish(() => deps.setTabCanExpandPane(tabId, false))
  }
  if (failure !== undefined) {
    throw failure
  }
}
