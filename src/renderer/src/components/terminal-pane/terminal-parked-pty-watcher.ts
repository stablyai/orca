import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isRemoteRuntimePtyId, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { startParkedTerminalByteWatcher } from './parked-terminal-byte-watcher'
import { subscribeToPtyExit } from './pty-dispatcher'
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import {
  isParkRestorableTerminalPty,
  type TerminalParkRestorePolicy
} from './terminal-hidden-view-parking'
import type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'
import {
  resolveTabTitleAfterPaneClose,
  shouldClearLaunchAgentForClosedPane
} from './terminal-pane-close-identity'
import {
  capturedPanesByTabId,
  markParkedTerminalWatcherOwnershipRestored,
  notifyParkedTerminalWatcherOwnershipLoss,
  parkedWatchersByTabId,
  type ParkedTabWatcherEntry,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

export function startParkedPtyWatcher(args: {
  worktreeId: string
  tab: ParkableTerminalTabModel
  pane: ParkedTerminalPaneCapture
  entry: ParkedTabWatcherEntry
  restoreTitleOnRegister: boolean
  restorePolicy: TerminalParkRestorePolicy
}): void {
  const { worktreeId, tab, pane, entry, restoreTitleOnRegister, restorePolicy } = args
  const state = useAppStore.getState()
  const ptyId = pane.ptyId
  // Why: the tab model can change after the park decision, and legacy leaf ids make pane keys throw.
  if (
    !ptyId ||
    entry.disposersByPtyId.has(ptyId) ||
    !isTerminalLeafId(pane.leafId) ||
    !isParkRestorableTerminalPty(ptyId, worktreeId, restorePolicy)
  ) {
    return
  }
  let exitHandled = false
  const handlePtyExit = (_code: number, { hadPrimary }: { hadPrimary: boolean }): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    const hadSiblingWatcher = entry.disposersByPtyId.size > 1
    const dispose = entry.disposersByPtyId.get(ptyId)
    entry.disposersByPtyId.delete(ptyId)
    dispose?.()
    useAppStore.getState().clearRuntimePaneTitle(tab.id, pane.paneId)
    if (hadSiblingWatcher) {
      discardPreHandlerPtyState(ptyId)
      collapseParkedExitedLeaf(tab.id, ptyId, {
        entry,
        leafId: pane.leafId,
        worktreeId,
        generation: tab.generation ?? null
      })
      return
    }
    if (hadPrimary) {
      notifyParkedTerminalWatcherOwnershipLoss(tab.id, entry, 'primary-exit-unowned')
      return
    }

    // Why: the empty entry prevents a pending pinned-close confirmation from restarting the dead PTY.
    closeTerminalTab(tab.id, {
      captureRecentlyClosed: false,
      hostCloseReason: 'pty-exit',
      lifecyclePtyId: ptyId,
      onClosed: () => {
        discardPreHandlerPtyState(ptyId)
        if (parkedWatchersByTabId.get(tab.id) === entry) {
          parkedWatchersByTabId.delete(tab.id)
        }
      },
      onCancel: () => {
        notifyParkedTerminalWatcherOwnershipLoss(tab.id, entry, 'close-cancelled')
      }
    })
  }
  const initialTitle = state.runtimePaneTitlesByTabId[tab.id]?.[pane.paneId]
  const disposeWatcher = startParkedTerminalByteWatcher({
    ptyId,
    tabId: tab.id,
    worktreeId,
    leafId: pane.leafId,
    paneId: pane.paneId,
    drivesTabTitle: pane.drivesTabTitle,
    ...(initialTitle !== undefined ? { initialTitle } : {}),
    ...(restoreTitleOnRegister ? { restoreTitleOnRegister: true } : {}),
    sendInput: (data) => {
      sendRuntimePtyInput(useAppStore.getState().settings, ptyId, data)
    }
  })
  let unsubscribeExit: () => void
  try {
    unsubscribeExit = isRemoteRuntimePtyId(ptyId)
      ? () => {}
      : subscribeToPtyExit(ptyId, handlePtyExit, { adoptPreHandlerExit: true })
  } catch (error) {
    entry.paneIdByPtyId.delete(ptyId)
    entry.disposersByPtyId.delete(ptyId)
    try {
      disposeWatcher()
    } catch {
      // Why: preserve the subscription failure that prevented watcher ownership.
    }
    throw error
  }
  entry.paneIdByPtyId.set(ptyId, pane.paneId)
  entry.disposersByPtyId.set(ptyId, () => {
    unsubscribeExit()
    disposeWatcher()
  })
  markParkedTerminalWatcherOwnershipRestored(entry)
}

type ParkedExitedLeafWatcherFallback = {
  entry: ParkedTabWatcherEntry
  leafId: string
  worktreeId: string
  generation: number | null
}

function resolveUnoccupiedParkedExitFallbackLeaf(
  layout: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId'][string] | undefined,
  leafId: string,
  ptyId: string
): string | null {
  const boundPtyId = layout?.ptyIdsByLeafId?.[leafId]
  return boundPtyId === undefined || boundPtyId === ptyId ? leafId : null
}

function isCurrentParkedExitedLeafWatcher(
  state: ReturnType<typeof useAppStore.getState>,
  tabId: string,
  watcher: ParkedExitedLeafWatcherFallback
): boolean {
  const liveTab = (state.tabsByWorktree[watcher.worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId
  )
  return (
    liveTab !== undefined &&
    parkedWatchersByTabId.get(tabId) === watcher.entry &&
    watcher.entry.worktreeId === watcher.worktreeId &&
    (liveTab.generation ?? null) === watcher.generation
  )
}

function resolveParkedExitedLeafId(
  state: ReturnType<typeof useAppStore.getState>,
  tabId: string,
  ptyId: string,
  watcher?: ParkedExitedLeafWatcherFallback
): string | null {
  if (watcher && !isCurrentParkedExitedLeafWatcher(state, tabId, watcher)) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  const boundLeafId = Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
    ([, boundPtyId]) => boundPtyId === ptyId
  )?.[0]
  if (boundLeafId) {
    return boundLeafId
  }
  if (watcher) {
    return resolveUnoccupiedParkedExitFallbackLeaf(layout, watcher.leafId, ptyId)
  }
  const entry = parkedWatchersByTabId.get(tabId)
  const capture = capturedPanesByTabId.get(tabId)
  if (!entry || !capture || capture.worktreeId !== entry.worktreeId) {
    return null
  }
  const liveTab = (state.tabsByWorktree[entry.worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId
  )
  if (!liveTab || capture.generation !== (liveTab.generation ?? null)) {
    return null
  }
  const capturedLeafId = capture.panes.find((pane) => pane.ptyId === ptyId)?.leafId
  return capturedLeafId
    ? resolveUnoccupiedParkedExitFallbackLeaf(layout, capturedLeafId, ptyId)
    : null
}

export function collapseParkedExitedLeaf(
  tabId: string,
  ptyId: string,
  watcher?: ParkedExitedLeafWatcherFallback
): void {
  const state = useAppStore.getState()
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafId = resolveParkedExitedLeafId(state, tabId, ptyId, watcher)
  if (!leafId) {
    return
  }
  const detached = detachTerminalLayoutLeaf(layout, leafId)
  if (!detached) {
    return
  }
  const terminalTab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  if (shouldClearLaunchAgentForClosedPane(terminalTab, ptyId)) {
    state.clearTabLaunchAgent(tabId)
  }
  state.setTabLayout(tabId, detached.sourceLayout)
  const activeLeafId = detached.sourceLayout.activeLeafId
  const activePtyId = activeLeafId
    ? detached.sourceLayout.ptyIdsByLeafId?.[activeLeafId]
    : undefined
  const activePaneId = activePtyId
    ? (parkedWatchersByTabId.get(tabId)?.paneIdByPtyId.get(activePtyId) ?? null)
    : null
  state.updateTabTitle(
    tabId,
    resolveTabTitleAfterPaneClose(state.runtimePaneTitlesByTabId[tabId] ?? {}, activePaneId)
  )
}
