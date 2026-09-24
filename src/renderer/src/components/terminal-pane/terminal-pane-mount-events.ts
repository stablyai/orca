import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  CLOSE_TERMINAL_PANE_EVENT,
  SET_TERMINAL_PANE_TITLE_EVENT,
  type CloseTerminalPaneDetail,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
import { consumePendingWebRuntimeSplitMirrorTelemetry } from '@/runtime/web-runtime-session'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  splitPaneWithOneShotStartup,
  recordRuntimeCreatedTerminalPaneSplit
} from './terminal-pane-lifecycle-primitives'
import { applyTerminalPaneCloseRequest } from './terminal-pane-lifecycle-close'
import {
  registerTerminalPaneSplitRequestHandler,
  resolveTerminalPaneSplitSourceId
} from './terminal-pane-split-request-routing'
import type { PtyConnectionDeps } from './pty-connection-types'

export function installTerminalPaneMountEvents(args: {
  manager: PaneManager
  deps: {
    tabId: string
    worktreeId: string
    isActive: boolean
    managerRef: React.RefObject<PaneManager | null>
    setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
    paneTitlesRef: React.RefObject<Record<number, string>>
    removePaneTitle: (paneId: number) => void
    removedTitleLeafIdsRef: React.RefObject<Set<string>>
    persistLayoutSnapshot: () => void
    syncCanExpandState: () => void
    queueResizeAll: (focusActive: boolean) => void
  }
  ptyDeps: PtyConnectionDeps
}): () => void {
  const { deps, ptyDeps } = args
  const unregisterTerminalPaneSplitRequestHandler = registerTerminalPaneSplitRequestHandler(
    deps.tabId,
    deps.worktreeId,
    (detail) => {
      const mgr = deps.managerRef.current
      if (!mgr) {
        return
      }
      if (detail.newLeafId && mgr.getNumericIdForLeaf(detail.newLeafId) !== null) {
        return
      }
      const sourcePaneId = resolveTerminalPaneSplitSourceId(detail, (leafId) =>
        mgr.getNumericIdForLeaf(leafId)
      )
      if (sourcePaneId < 0) {
        return
      }
      const splitOptions = {
        ...(detail.newLeafId ? { leafId: detail.newLeafId } : {}),
        ...(detail.ptyId ? { ptyId: detail.ptyId } : {})
      }
      if (detail.command) {
        const createdPane = splitPaneWithOneShotStartup(ptyDeps, { command: detail.command }, () =>
          mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        )
        recordRuntimeCreatedTerminalPaneSplit(createdPane, {
          source: detail.telemetrySource ?? 'command',
          direction: detail.direction
        })
      } else {
        const createdPane = mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        const telemetrySuppressed = createdPane
          ? consumePendingWebRuntimeSplitMirrorTelemetry(detail.sourcePtyId, detail.direction)
          : false
        recordRuntimeCreatedTerminalPaneSplit(createdPane, {
          source: detail.telemetrySource ?? 'command',
          direction: detail.direction,
          telemetrySuppressed
        })
      }
    }
  )

  const onCliClosePane = (event: Event): void => {
    const detail = (event as CustomEvent<CloseTerminalPaneDetail>).detail
    if (!detail?.tabId || detail.tabId !== deps.tabId) {
      return
    }
    const mgr = deps.managerRef.current
    if (!mgr) {
      return
    }
    const result = applyTerminalPaneCloseRequest({
      detail,
      manager: mgr,
      getPtyIdForLeaf: (leafId) =>
        useAppStore.getState().terminalLayoutsByTabId[deps.tabId]?.ptyIdsByLeafId?.[leafId],
      closeTab: () => closeTerminalTab(deps.tabId, { skipRunningProcessConfirm: true }),
      closeTabPreservingPty: () => {
        const store = useAppStore.getState()
        if (detail.retireSurface && detail.leafId) {
          store.retireAgentPaneAuthority(makePaneKey(deps.tabId, detail.leafId), {
            preserveSleepingAgentSession: true
          })
        }
        store.closeTab(deps.tabId, {
          reason: 'pty-exit',
          captureRecentlyClosed: false
        })
      }
    })
    if (result !== 'pane') {
      return
    }
    scheduleRuntimeGraphSync()
    deps.syncCanExpandState()
    deps.queueResizeAll(deps.isActive)
    deps.persistLayoutSnapshot()
  }

  const onSetPaneTitle = (event: Event): void => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a window CustomEvent's detail is untyped at the Event boundary; the sole dispatcher sets SetTerminalPaneTitleDetail.
    const detail = (event as CustomEvent<SetTerminalPaneTitleDetail>).detail
    if (!detail?.tabId || detail.tabId !== deps.tabId) {
      return
    }
    // Why: numeric pane ids are reused after replay/teardown, so a stale leaf must not rename a sibling.
    const resolution = resolveLeafIdForManager(deps.tabId, detail.leafId, deps.managerRef.current)
    if (resolution.status !== 'resolved') {
      return
    }
    const paneId = resolution.numericPaneId
    const title = detail.title
    if (title) {
      deps.setPaneTitles((previous) => ({ ...previous, [paneId]: title }))
      deps.paneTitlesRef.current = { ...deps.paneTitlesRef.current, [paneId]: title }
      deps.removedTitleLeafIdsRef.current.delete(detail.leafId)
    } else {
      deps.removePaneTitle(paneId)
    }
    deps.persistLayoutSnapshot()
  }

  window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  window.addEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
  return () => {
    unregisterTerminalPaneSplitRequestHandler()
    window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
    window.removeEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
  }
}
