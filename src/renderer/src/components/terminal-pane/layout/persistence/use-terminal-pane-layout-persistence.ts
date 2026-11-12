import { usePaneScrollbackClear } from '../../snapshots/use-pane-scrollback-clear'
import { usePersistedPaneTitleActions } from '../../titles/use-persisted-pane-title-actions'
import { useSyntheticPaneTitlePruning } from '../../titles/use-synthetic-pane-title-pruning'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../../../store/index'

import { serializeTerminalLayout } from '../terminal-layout-dom-serialization'
import { mergeCapturedLeafState } from '../../snapshots/merge-captured-leaf-state'
import { resolveTerminalLayoutActiveLeafId } from '../ownership/terminal-layout-active-leaf'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

import type { TerminalPaneStartupController } from '../../controller/use-terminal-pane-startup-actions'

import {
  mergeLayoutTitlesByLeafId,
  retainLayoutScrollback
} from './terminal-pane-layout-snapshot-merge'
import { retireLeavesFromTerminalLayout } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-layout-leaf-retirement'

export function useTerminalPaneLayoutPersistence(controller: TerminalPaneStartupController) {
  const {
    clearedScrollbackLeafIdsRef,
    chatLeafId,
    containerRef,
    isChatViewMode,
    expandedPaneIdRef,
    managerRef,
    paneCount,
    paneTitles,
    paneTitlesRef,
    paneTransportsRef,
    remotePaneLayoutPusherRef,
    removedTitleLeafIdsRef,
    savedLayout,
    setPaneTitles,
    setTabLayout,
    tabId,
    terminalTab,
    worktreeId
  } = controller
  // Exclude host-dropped layouts from writes while their panes finish exiting, or persistence can resurrect them.
  const hostRetiredLeafIdsRef = useRef<ReadonlySet<string>>(new Set())
  const chatOwnerRef = useRef({ chatLeafId, isChatViewMode })
  useLayoutEffect(() => {
    chatOwnerRef.current = { chatLeafId, isChatViewMode }
  }, [chatLeafId, isChatViewMode])
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    let layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((pane) => pane.leafId))
    // PaneManager retains this callback for its entire mount.
    const { chatLeafId, isChatViewMode } = chatOwnerRef.current
    if (isChatViewMode && chatLeafId && currentPanes.some((pane) => pane.leafId === chatLeafId)) {
      layout.chatLeafId = chatLeafId
    }
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    retainLayoutScrollback(layout, existing, scrollbackPreserveLeafIds)
    const livePtyEntries = currentPanes
      .map(
        (pane) => [pane.leafId, paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null] as const
      )
      .filter(
        (entry): entry is readonly [(typeof currentPanes)[number]['leafId'], string] =>
          entry[1] !== null
      )
    const mergedPtyIds = mergeCapturedLeafState({
      prior: existing?.ptyIdsByLeafId,
      fresh: Object.fromEntries(livePtyEntries),
      currentLeafIds
    })
    if (Object.keys(mergedPtyIds).length > 0) {
      layout.ptyIdsByLeafId = mergedPtyIds
    }
    layout.activeLeafId = resolveTerminalLayoutActiveLeafId({
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      ptyIdsByLeafId: mergedPtyIds
    })
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    const titlesByLeafId = mergeLayoutTitlesByLeafId(
      currentPanes,
      existing?.titlesByLeafId,
      paneTitlesRef.current,
      removedTitleLeafIds
    )
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    const hostRetiredLeafIds = hostRetiredLeafIdsRef.current
    if (hostRetiredLeafIds.size > 0) {
      // Why: never retire the last pane here; the host drops a whole tab by itself.
      layout = retireLeavesFromTerminalLayout(layout, hostRetiredLeafIds) ?? layout
    }
    setTabLayout(tabId, layout)
    const hasRemotePane = Object.values(mergedPtyIds).some(
      (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
    )
    if (hasRemotePane) {
      // Why: a host keeps its titles when the field is absent, so clearing the last one sends {}.
      const clearedEveryTitle =
        !layout.titlesByLeafId &&
        [...currentLeafIds].some((leafId) => removedTitleLeafIds.has(leafId))
      remotePaneLayoutPusherRef.current?.push({
        worktreeId,
        tabId,
        layout: clearedEveryTitle ? { ...layout, titlesByLeafId: {} } : layout
      })
    }
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
  }, [
    tabId,
    setTabLayout,
    worktreeId,
    clearedScrollbackLeafIdsRef,
    containerRef,
    expandedPaneIdRef,
    managerRef,
    paneTitlesRef,
    paneTransportsRef,
    remotePaneLayoutPusherRef,
    removedTitleLeafIdsRef
  ])

  useEffect(() => {
    persistLayoutSnapshot()
  }, [chatLeafId, isChatViewMode, persistLayoutSnapshot])

  const { clearPaneScrollback } = usePaneScrollbackClear({
    clearedScrollbackLeafIdsRef,
    paneTransportsRef,
    persistLayoutSnapshot
  })

  const { changePaneTitle, showPaneTitle, removePaneTitle, handleClearPaneTitleShortcut } =
    usePersistedPaneTitleActions({
      managerRef,
      paneTitlesRef,
      removedTitleLeafIdsRef,
      setPaneTitles,
      tabId,
      worktreeId,
      persistLayoutSnapshot
    })

  useSyntheticPaneTitlePruning({
    managerRef,
    paneCount,
    paneTitles,
    paneTitlesRef,
    savedLayout,
    setPaneTitles,
    setTabLayout,
    tabId,
    terminalTab,
    persistLayoutSnapshot
  })

  return {
    hostRetiredLeafIdsRef,
    persistLayoutSnapshot,
    clearPaneScrollback,
    changePaneTitle,
    showPaneTitle,
    removePaneTitle,
    handleClearPaneTitleShortcut
  }
}

export type TerminalPaneLayoutController = TerminalPaneStartupController &
  ReturnType<typeof useTerminalPaneLayoutPersistence>
