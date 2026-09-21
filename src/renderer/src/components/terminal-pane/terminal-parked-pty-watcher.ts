import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { startParkedTerminalByteWatcher } from './parked-terminal-byte-watcher'
import { subscribeToPtyExit } from './pty-dispatcher'
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
  // Why: the pane's primary exit handler is gone from unmount and this sidecar
  // arrives a passive effect later, so an exit landing in between is buffered
  // and replayed to nobody. Registering would pin a dead PTY as a live parked
  // owner, and the runtime graph publishes its leaf on exactly that claim.
  if (ptyId && !entry.disposersByPtyId.has(ptyId) && hasPreHandlerPtyExit(ptyId)) {
    // Mirror handlePtyExit's first act: no live pane will ever overwrite this
    // slot, so leaving it would strand a dead pane's last title (a 'working'
    // agent title pins worktree status) until reveal or close.
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
    useAppStore.getState().clearRuntimePaneTitle(tab.id, pane.paneId)
    // A negative code is a synthetic loss sentinel, not a death certificate.
    // Preserve the tab so host shutdown/reconnect cannot be mistaken for an
    // explicit close by either this watcher or the orphan sweep.
    const provenExit = isProvenProcessExit(code)
    if (!provenExit) {
      useAppStore.getState().markUnverifiedPtyLoss(tab.id)
    }
    // Why: detach drops the session-bound exit observer (it pinned the disposed
    // pane's xterm buffers), so this sidecar is the sole owner of a parked PTY's
    // exit. A sleep/shutdown exit must keep the tab AND its layout — revival
    // belongs to the wake path — and must leave the buffered exit in place as
    // the tombstone that stops watcher syncs re-pinning the dead PTY.
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
    // Why: parity with the session observer's sole-newborn guard (pty-exit-hibernate) —
    // a worktree's only fresh-spawned shell nobody ever typed into can die on shell
    // startup (e.g. a failing .envrc); keep its tab readable instead of closing it and
    // stranding the user on Landing. Split siblings keep their own branch above.
    if (pane.untouchedFreshSpawn) {
      entry.disposersByPtyId.get(ptyId)?.()
      entry.disposersByPtyId.delete(ptyId)
      // Consume the buffered exit exactly as the pre-fix primary observer did — NOT
      // the sleep branch's tombstone. A tombstone would send reveal down connectIpcPty's
      // exitedBeforeAttach path, draining the exit into the reattached session (where
      // spawnedFreshPtyId is null, so the guard fails) and closing the tab the moment
      // the user reveals it. Consumption cannot let a later watcher sync re-register
      // this dead PTY: paneIdByPtyId deliberately keeps the slot, so
      // reconcileParkedWatcherPtyIds never computes it as added.
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

// Why these three markers: a pending renderer shutdown transaction, a
// suppressed intentional restart, or a committed sleep (host-initiated remote
// sleep marks it from the exit payload) all mean this exit is orchestrated —
// closing the tab would destroy state the wake/restart path owns. Host-sleep
// dispositions are remote-runtime-only and remote PTYs never reach this
// sidecar, so consumeCommittedPtyShutdownExit runs without an environment id.
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
