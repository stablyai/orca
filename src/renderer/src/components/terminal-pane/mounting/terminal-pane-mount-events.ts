import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  CLOSE_TERMINAL_PANE_EVENT,
  SET_TERMINAL_PANE_TITLE_EVENT,
  TOGGLE_SIDE_CHAT_EVENT,
  type ToggleSideChatDetail,
  type CloseTerminalPaneDetail,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
import { consumePendingWebRuntimeSplitMirrorTelemetry } from '@/runtime/hosted-terminals/actions/web-runtime-terminal-split'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { closeTerminalTab } from '../../terminal/terminal-tab-actions'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { splitPaneWithOneShotStartup } from '../layout/split/pane-split-startup'
import { recordCreatedTerminalPaneSplit } from '../layout/split/terminal-pane-split-completion'
import { applyTerminalPaneCloseRequest } from '../layout/close/terminal-pane-lifecycle-close'
import {
  registerTerminalPaneSplitRequestHandler,
  resolveTerminalPaneSplitSourceId
} from '../layout/split/terminal-pane-split-request-routing'
import type { PtyConnectionDeps } from '../pty-connection/pty-connection-deps'
import type { DetachTerminalPaneToNewTab } from '../layout/detach/terminal-pane-tab-detach'
import {
  registerTerminalPaneMoveToNewTabHandler,
  resolvePaneMoveTargetGroup
} from '../layout/detach/terminal-pane-move-request-routing'
import { toggleSideChatInTab } from '../side-chat/side-chat-actions'

export function installTerminalPaneMountEvents(args: {
  manager: PaneManager
  deps: {
    tabId: string
    worktreeId: string
    isActive: boolean
    managerRef: React.RefObject<PaneManager | null>
    showPaneTitle: (paneId: number, title: string | null) => void
    persistLayoutSnapshot: () => void
    syncCanExpandState: () => void
    queueResizeAll: (focusActive: boolean) => void
    detachPaneToNewTab?: DetachTerminalPaneToNewTab
  }
  ptyDeps: PtyConnectionDeps
}): () => void {
  const { deps, ptyDeps } = args
  const { detachPaneToNewTab } = deps
  const unregisterPaneMoveHandler = detachPaneToNewTab
    ? registerTerminalPaneMoveToNewTabHandler(deps.worktreeId, deps.tabId, async (move) => {
        const sourcePaneId = deps.managerRef.current?.getNumericIdForLeaf(move.leafId) ?? null
        const group = resolvePaneMoveTargetGroup(
          useAppStore.getState(),
          deps.worktreeId,
          deps.tabId,
          move
        )
        if (sourcePaneId === null || !group) {
          return null
        }
        return detachPaneToNewTab(sourcePaneId, { ...group, targetTabId: move.targetTabId })
      })
    : () => {}
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
        const startup = { command: detail.command, ...(detail.env ? { env: detail.env } : {}) }
        const createdPane = splitPaneWithOneShotStartup(ptyDeps, startup, () =>
          mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        )
        recordCreatedTerminalPaneSplit(createdPane, {
          source: detail.telemetrySource ?? 'command',
          direction: detail.direction
        })
      } else {
        const createdPane = mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        const telemetrySuppressed = createdPane
          ? consumePendingWebRuntimeSplitMirrorTelemetry(detail.sourcePtyId, detail.direction)
          : false
        recordCreatedTerminalPaneSplit(createdPane, {
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
      closeTab: (reason) =>
        closeTerminalTab(deps.tabId, { reason, skipRunningProcessConfirm: true }),
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
    const detail: SetTerminalPaneTitleDetail | null = event.detail
    if (!detail || detail.tabId !== deps.tabId) {
      return
    }
    const resolution = resolveLeafIdForManager(deps.tabId, detail.leafId, deps.managerRef.current)
    if (resolution.status === 'resolved') {
      deps.showPaneTitle(resolution.numericPaneId, detail.title)
    }
  }

  const onToggleSideChat = (event: Event): void => {
    const detail: ToggleSideChatDetail | null = event instanceof CustomEvent ? event.detail : null
    const manager = deps.managerRef.current
    if (detail?.tabId === deps.tabId && manager) {
      toggleSideChatInTab({ manager, tabId: deps.tabId, worktreeId: deps.worktreeId })
    }
  }

  window.addEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
  window.addEventListener(TOGGLE_SIDE_CHAT_EVENT, onToggleSideChat)
  window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  return () => {
    window.removeEventListener(SET_TERMINAL_PANE_TITLE_EVENT, onSetPaneTitle)
    window.removeEventListener(TOGGLE_SIDE_CHAT_EVENT, onToggleSideChat)
    unregisterPaneMoveHandler()
    unregisterTerminalPaneSplitRequestHandler()
    window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
  }
}
