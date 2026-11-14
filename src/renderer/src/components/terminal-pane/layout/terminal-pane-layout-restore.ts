import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store/index'
import { applyExpandedLayoutTo } from './expand/expanded-pane-layout'
import { replayTerminalLayout } from './terminal-layout-replay'
import { restoreScrollbackBuffers } from '../snapshots/saved-terminal-output-replay'
import { canReleaseReplayedScrollbackFromStore } from '../snapshots/replayed-scrollback-store-release'
import { resolveLeafScrollbackBuffers } from '../snapshots/leaf-scrollback-resolution'
import type { TerminalPaneLifecycleRefs } from '../mounting/use-terminal-pane-lifecycle-refs'
import type { UseTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'
import type { PtyConnectionDeps } from '../pty-connection/pty-connection-deps'
import { resolveParkRevealLiveTuiLeafIds } from '../parking/lifecycle/park-reveal-live-tui-leaves'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { mapRestoredPaneTitlesByPaneId } from '../titles/restored-pane-titles'
import { replayLayoutWithOneShotParkIntent } from '../parking/one-shot-park-replay'

export function restoreTerminalPaneLayout(args: {
  manager: PaneManager
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  ptyDeps: PtyConnectionDeps
  initialLayoutHadBuffers: boolean
}): Map<string, number> {
  const { manager, deps, refs, ptyDeps, initialLayoutHadBuffers } = args
  const { initialLayoutRef, tabId, worktreeId, isActive, managerRef } = deps
  // Read before replay consumes the one-shot park intent.
  const liveAltScreenLeafIds = resolveParkRevealLiveTuiLeafIds(
    ptyDeps.mountFollowsTerminalPark,
    initialLayoutRef.current.ptyIdsByLeafId
  )
  const restoredPaneByLeafId = replayLayoutWithOneShotParkIntent(ptyDeps, () =>
    replayTerminalLayout(manager, initialLayoutRef.current, isActive)
  )
  // Switch point: history comes only from the terminal's host (L236), never the window's copy.
  const localOnlyBuffers = ORCA_LAYOUT_OWNER_IS_MAIN
    ? undefined
    : useAppStore.getState().localOnlyScrollbackByTabId[tabId]
  const restoredBuffers = ORCA_LAYOUT_OWNER_IS_MAIN
    ? undefined
    : resolveLeafScrollbackBuffers({
        shared: initialLayoutRef.current,
        localOnly: localOnlyBuffers
      })
  restoreScrollbackBuffers(
    manager,
    restoredBuffers,
    restoredPaneByLeafId,
    deps.replayingPanesRef,
    refs.restoredViewportBlankingPanesRef,
    liveAltScreenLeafIds
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
    const retainedInline = Object.fromEntries(
      Object.entries(restoredBuffers).filter(
        ([leafId]) =>
          restoredPaneByLeafId.has(leafId) &&
          initialLayoutRef.current.scrollbackRefsByLeafId?.[leafId] === undefined &&
          !deps.clearedScrollbackLeafIdsRef?.current.has(leafId)
      )
    )
    initialLayoutRef.current =
      Object.keys(retainedInline).length > 0
        ? { ...layoutWithoutRestoredBuffers, buffersByLeafId: retainedInline }
        : layoutWithoutRestoredBuffers
    if (initialLayoutHadBuffers) {
      useAppStore.getState().setTabLayout(tabId, layoutWithoutRestoredBuffers)
    }
    // Same release for the local-only home: xterm owns the bytes now and the next park re-captures.
    if (localOnlyBuffers) {
      useAppStore.getState().setTabLocalOnlyScrollback(tabId, null)
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
