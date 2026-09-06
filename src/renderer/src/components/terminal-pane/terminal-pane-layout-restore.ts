import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { applyExpandedLayoutTo } from './expand-collapse'
import { replayTerminalLayout, restoreScrollbackBuffers } from './layout-serialization'
import { canReleaseReplayedScrollbackFromStore } from './replayed-scrollback-store-release'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { PtyConnectionDeps } from './pty-connection-types'
import {
  mapRestoredPaneTitlesByPaneId,
  replayLayoutWithOneShotParkIntent
} from './terminal-pane-lifecycle-primitives'

export function restoreTerminalPaneLayout(args: {
  manager: PaneManager
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  ptyDeps: PtyConnectionDeps
  initialLayoutHadBuffers: boolean
}): Map<string, number> {
  const { manager, deps, refs, ptyDeps, initialLayoutHadBuffers } = args
  const { initialLayoutRef, tabId, worktreeId, isActive, managerRef } = deps
  const restoredPaneByLeafId = replayLayoutWithOneShotParkIntent(ptyDeps, () =>
    replayTerminalLayout(manager, initialLayoutRef.current, isActive)
  )
  const restoredBuffers = initialLayoutRef.current.buffersByLeafId
  restoreScrollbackBuffers(
    manager,
    restoredBuffers,
    restoredPaneByLeafId,
    deps.replayingPanesRef,
    refs.restoredViewportBlankingPanesRef
  )
  const hasScrollbackRefs = Boolean(initialLayoutRef.current.scrollbackRefsByLeafId)
  if (
    restoredBuffers &&
    canReleaseReplayedScrollbackFromStore({
      hasScrollbackRefs,
      worktreeId,
      repos: useAppStore.getState().repos
    })
  ) {
    const layoutWithoutRestoredBuffers = { ...initialLayoutRef.current }
    delete layoutWithoutRestoredBuffers.buffersByLeafId
    if (hasScrollbackRefs) {
      initialLayoutRef.current = layoutWithoutRestoredBuffers
    }
    if (initialLayoutHadBuffers) {
      useAppStore.getState().setTabLayout(tabId, layoutWithoutRestoredBuffers)
    }
  }
  const restoredTitles = mapRestoredPaneTitlesByPaneId(
    initialLayoutRef.current.titlesByLeafId,
    restoredPaneByLeafId
  )
  if (Object.keys(restoredTitles).length > 0) {
    deps.setPaneTitles((prev) => ({ ...prev, ...restoredTitles }))
    deps.paneTitlesRef.current = { ...deps.paneTitlesRef.current, ...restoredTitles }
  }
  const restoredActivePaneId =
    (initialLayoutRef.current.activeLeafId
      ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
      : null) ??
    manager.getActivePane()?.id ??
    manager.getPanes()[0]?.id ??
    null
  if (restoredActivePaneId !== null) {
    manager.setActivePane(restoredActivePaneId, { focus: isActive })
  }
  const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
    ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
    : null
  if (restoredExpandedPaneId !== null && manager.getPanes().length > 1) {
    deps.setExpandedPane(restoredExpandedPaneId)
    applyExpandedLayoutTo(restoredExpandedPaneId, {
      managerRef,
      containerRef: deps.containerRef,
      expandedStyleSnapshotRef: deps.expandedStyleSnapshotRef
    })
  } else {
    deps.setExpandedPane(null)
  }
  return restoredPaneByLeafId
}
