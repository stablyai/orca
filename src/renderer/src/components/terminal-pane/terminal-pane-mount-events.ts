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
    setPaneTitle: (paneId: number, title: string | null) => void
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
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: SetTerminalPaneTitleDetail = event.detail
    if (!detail || detail.tabId !== deps.tabId) {
      return
    }
    const resolution = resolveLeafIdForManager(deps.tabId, detail.leafId, deps.managerRef.current)
    if (resolution.status === 'resolved') {
      deps.setPaneTitle(resolution.numericPaneId, detail.title)
    }
  }

  window.addEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
  window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  return () => {
    window.removeEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
    unregisterTerminalPaneSplitRequestHandler()
    window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  }
}
