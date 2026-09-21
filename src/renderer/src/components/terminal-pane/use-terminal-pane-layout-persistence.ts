import { useCallback, useEffect } from 'react'
import { useAppStore } from '../../store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { serializeTerminalLayout } from './layout-serialization'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scrollback-clear'
import { clearWebRuntimeTerminalBuffer } from '@/runtime/web-runtime-session'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '@/lib/terminal-pane-title-sanitization'
import type { TerminalPaneStartupController } from './use-terminal-pane-startup-actions'

export function useTerminalPaneLayoutPersistence(controller: TerminalPaneStartupController) {
  const {
    clearedScrollbackLeafIdsRef,
    containerRef,
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
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    const layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((pane) => pane.leafId))
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
    }
    const mergedScrollbackRefs = mergeCapturedLeafState({
      prior: existing?.scrollbackRefsByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedScrollbackRefs).length > 0) {
      layout.scrollbackRefsByLeafId = mergedScrollbackRefs
    }
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
    const titlesByLeafId: Record<string, string> = {}
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    for (const pane of currentPanes) {
      const existingTitle = existing?.titlesByLeafId?.[pane.leafId]
      if (existingTitle && !removedTitleLeafIds.has(pane.leafId)) {
        titlesByLeafId[pane.leafId] = existingTitle
      }
    }
    const titles = paneTitlesRef.current
    for (const pane of currentPanes) {
      const title = titles[pane.id]
      if (title) {
        titlesByLeafId[pane.leafId] = title
        removedTitleLeafIds.delete(pane.leafId)
      }
    }
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    setTabLayout(tabId, layout)
    const hasRemotePane = Object.values(mergedPtyIds).some(
      (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
    )
    if (hasRemotePane) {
      remotePaneLayoutPusherRef.current?.push({ worktreeId, tabId, layout })
    }
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [tabId, setTabLayout, worktreeId])

  const clearPaneScrollback = useCallback(
    (pane: ManagedPane): void => {
      clearedScrollbackLeafIdsRef.current.add(pane.leafId)
      clearTerminalScrollbackAndFollowOutput(pane.terminal)
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const clearedRemoteHostBuffer = clearWebRuntimeTerminalBuffer(ptyId)
      if (!clearedRemoteHostBuffer && ptyId) {
        window.api.pty.clearBuffer(ptyId)
      }
      persistLayoutSnapshot()
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [paneTransportsRef, persistLayoutSnapshot]
  )

  const removePaneTitle = useCallback(
    (paneId: number) => {
      setPaneTitles((previous) => {
        if (!(paneId in previous)) {
          return previous
        }
        const next = { ...previous }
        delete next[paneId]
        return next
      })
      if (paneId in paneTitlesRef.current) {
        const next = { ...paneTitlesRef.current }
        delete next[paneId]
        paneTitlesRef.current = next
      }
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      if (leafId) {
        removedTitleLeafIdsRef.current.add(leafId)
      }
      persistLayoutSnapshot()
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [persistLayoutSnapshot]
  )
  const handleClearPaneTitleShortcut = useCallback(
    (paneId: number) => {
      if (!paneTitlesRef.current[paneId]) {
        return
      }
      removePaneTitle(paneId)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [removePaneTitle]
  )

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((previous) => {
      if (!previous[paneId] || !isSyntheticSinglePaneTitle(previous[paneId], terminalTab)) {
        return previous
      }
      const next = { ...previous }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [paneCount, paneTitles, persistLayoutSnapshot, terminalTab])

  return {
    persistLayoutSnapshot,
    clearPaneScrollback,
    removePaneTitle,
    handleClearPaneTitleShortcut
  }
}

export type TerminalPaneLayoutController = TerminalPaneStartupController &
  ReturnType<typeof useTerminalPaneLayoutPersistence>
