import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { startParkedTerminalByteWatcher } from './parked-terminal-byte-watcher'
import { subscribeToPtyExit } from './pty-dispatcher'
import { isPtyExitReplacedByRestart } from './pty-exit-delivery'
import {
  consumePreHandlerPtyState,
  discardPreHandlerPtyState,
  hasPreHandlerPtyExit
} from './pty-pre-handler-buffer'
import { consumeCommittedPtyShutdownExit } from './pty-shutdown-exit-deferral'
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
  // An exit can land between primary unmount and passive sidecar install; refusing its buffered tombstone prevents publishing a dead parked owner.
  if (ptyId && !entry.disposersByPtyId.has(ptyId) && hasPreHandlerPtyExit(ptyId)) {
    // Clear dead runtime titles immediately; no live pane remains to remove a stale working status.
    state.clearRuntimePaneTitle(tab.id, pane.paneId)
    return
  }
  if (
    !ptyId ||
    entry.disposersByPtyId.has(ptyId) ||
    !isTerminalLeafId(pane.leafId) ||
    !isParkRestorableTerminalPty(ptyId, worktreeId, restorePolicy)
  ) {
    return
  }
  const handlePtyExit = (code: number, { hadPrimary }: { hadPrimary: boolean }): void => {
    // Replacement waits for a future connect, but the dead process’s working title must clear now.
    useAppStore.getState().clearRuntimePaneTitle(tab.id, pane.paneId)
    if (isPtyExitReplacedByRestart(ptyId)) {
      // Why: the pane lives on under its replacement PTY; only this watcher's subscription ends.
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      return
    }
    // Negative codes prove lost contact, not process death; preserve the tab through host shutdown/reconnect.
    const provenExit = isProvenProcessExit(code)
    if (!provenExit) {
      useAppStore.getState().markUnverifiedPtyLoss(tab.id)
    }
    // Detach removed the primary observer; this sidecar must preserve sleep state/layout and keep the buffered-exit tombstone against stale watcher re-registration.
    if (!hadPrimary && isSleepPreservedParkedPtyExit(ptyId)) {
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      return
    }
    if (!provenExit) {
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      discardPreHandlerPtyState(ptyId)
      if (entry.disposersByPtyId.size === 0 && parkedWatchersByTabId.get(tab.id) === entry) {
        parkedWatchersByTabId.delete(tab.id)
      }
      return
    }
    if (entry.disposersByPtyId.size > 1) {
      discardPreHandlerPtyState(ptyId)
      collapseParkedExitedLeaf(tab.id, ptyId)
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      return
    }
    if (hadPrimary) {
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      return
    }
    // Match the sole-newborn guard: keep an untouched startup shell’s failure readable instead of stranding the user on Landing.
    if (pane.untouchedFreshSpawn) {
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      // Consume newborn exit instead of retaining a sleep tombstone: replay on reveal would bypass the fresh-spawn guard and close the tab. Retained paneIdByPtyId prevents re-registration.
      consumePreHandlerPtyState(ptyId)
      return
    }

    // Why: the empty entry prevents a pending pinned-close confirmation from restarting the dead PTY.
    entry.disposersByPtyId.get(ptyId)?.()
    entry.disposersByPtyId.delete(ptyId)
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
      onCancel: () => {}
    })
  }
  const initialTitle = state.runtimePaneTitlesByTabId[tab.id]?.[pane.paneId]
  const disposeWatcher = startParkedTerminalByteWatcher({
    ptyId,
    workspaceOwner: pane.workspaceOwner,
    tabId: tab.id,
    worktreeId,
    leafId: pane.leafId,
    paneId: pane.paneId,
    drivesTabTitle: pane.drivesTabTitle,
    ...(initialTitle !== undefined ? { initialTitle } : {}),
    ...(restoreTitleOnRegister ? { restoreTitleOnRegister: true } : {})
  })
  const unsubscribeExit = isRemoteRuntimePtyId(ptyId)
    ? () => {}
    : subscribeToPtyExit(ptyId, handlePtyExit)
  entry.paneIdByPtyId.set(ptyId, pane.paneId)
  entry.disposersByPtyId.set(ptyId, () => {
    unsubscribeExit()
    disposeWatcher()
  })
}

// Shutdown, suppressed restart and committed sleep markers preserve state for wake/restart. Remote host-sleep dispositions never reach this sidecar, so no environment ID is needed.
function isSleepPreservedParkedPtyExit(ptyId: string): boolean {
  const state = useAppStore.getState()
  if (state.isPtyShutdownPending(ptyId) || state.suppressedPtyExitIds[ptyId]) {
    return true
  }
  return consumeCommittedPtyShutdownExit(ptyId, null)
}

export function collapseParkedExitedLeaf(tabId: string, ptyId: string): void {
  const state = useAppStore.getState()
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafId =
    capturedPanesByTabId.get(tabId)?.panes.find((pane) => pane.ptyId === ptyId)?.leafId ??
    Object.entries(layout?.ptyIdsByLeafId ?? {}).find(([, boundPtyId]) => boundPtyId === ptyId)?.[0]
  if (leafId) {
    collapseParkedTerminalLeaf(tabId, leafId, ptyId)
  }
}

/** Removes one leaf from a parked tab's stored layout; a no-op once the leaf is gone. */
export function collapseParkedTerminalLeaf(tabId: string, leafId: string, ptyId?: string): void {
  const state = useAppStore.getState()
  const layout = state.terminalLayoutsByTabId[tabId]
  const detached = detachTerminalLayoutLeaf(layout, leafId)
  if (!detached) {
    return
  }
  const terminalTab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  if (shouldClearLaunchAgentForClosedPane(terminalTab, ptyId ?? layout?.ptyIdsByLeafId?.[leafId])) {
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
