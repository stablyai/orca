import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
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

  window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  return () => {
    unregisterTerminalPaneSplitRequestHandler()
    window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  }
}
