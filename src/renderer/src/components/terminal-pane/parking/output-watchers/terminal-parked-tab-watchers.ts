/** Parking removes pane byte parsers; run pane-less watchers until reveal, exit or teardown. */
import { isTerminalLeafId } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import { discardPreHandlerPtyState } from '../../pty-transport/delivery/pty-pre-handler-buffer'
import { isParkRestorableTerminalPty } from '../retention/terminal-hidden-view-parking'

import {
  reconcileParkedWatcherPtyIds,
  type ParkableTerminalTabModel
} from './terminal-parked-watcher-reconciliation'
import { collapseParkedExitedLeaf, startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  retireParkedTerminalTab,
  parkedWatchersByTabId,
  type ParkedTabWatcherEntry,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

import {
  parkedTerminalTabCoverage,
  parkRestorePolicyFromState
} from './parked-terminal-tab-coverage'

function startParkedTabWatchers(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  restoreTitleOnRegister: boolean
): void {
  const entry: ParkedTabWatcherEntry = {
    worktreeId,
    tabPtyId: tab.ptyId,
    paneIdByPtyId: new Map(),
    disposersByPtyId: new Map()
  }
  parkedWatchersByTabId.set(tab.id, entry)
  const restorePolicy = parkRestorePolicyFromState(useAppStore.getState())
  for (const pane of parkedTerminalTabCoverage(worktreeId, tab).panes) {
    startParkedPtyWatcher({
      worktreeId,
      tab,
      pane,
      entry,
      restoreTitleOnRegister,
      restorePolicy
    })
  }
}

function reconcileParkedTabWatchers(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  entry: ParkedTabWatcherEntry,
  restoreTitleOnRegister: boolean
): void {
  const state = useAppStore.getState()
  const expectedPanes = watchablePanes(worktreeId, tab)
  const expectedPtyIds = new Set(expectedPanes.keys())
  const reconciliation = reconcileParkedWatcherPtyIds({
    currentTabPtyId: tab.ptyId,
    entryTabPtyId: entry.tabPtyId,
    paneIdByPtyId: entry.paneIdByPtyId,
    expectedPtyIds
  })
  if (reconciliation.restartAll) {
    const retainedTitles = reconciliation.retainedPtyIds.flatMap((ptyId) => {
      const paneId = entry.paneIdByPtyId.get(ptyId)
      const title =
        paneId === undefined ? undefined : state.runtimePaneTitlesByTabId[tab.id]?.[paneId]
      return paneId !== undefined && title !== undefined ? [{ paneId, title }] : []
    })
    for (const paneId of reconciliation.retiredPaneIds) {
      state.clearRuntimePaneTitle(tab.id, paneId)
    }
    disposeParkedTabWatchers(tab.id)
    for (const { paneId, title } of retainedTitles) {
      useAppStore.getState().setRuntimePaneTitle(tab.id, paneId, title)
    }
    startParkedTabWatchers(worktreeId, tab, restoreTitleOnRegister)
    return
  }
  for (const [ptyId, paneId] of Array.from(entry.paneIdByPtyId)) {
    if (expectedPtyIds.has(ptyId)) {
      continue
    }
    entry.paneIdByPtyId.delete(ptyId)
    const dispose = entry.disposersByPtyId.get(ptyId)
    entry.disposersByPtyId.delete(ptyId)
    dispose?.()
    state.clearRuntimePaneTitle(tab.id, paneId)
  }
  const restorePolicy = parkRestorePolicyFromState(useAppStore.getState())
  for (const ptyId of reconciliation.addedPtyIds) {
    const pane = expectedPanes.get(ptyId)
    if (pane) {
      startParkedPtyWatcher({
        worktreeId,
        tab,
        pane,
        entry,
        restoreTitleOnRegister,
        restorePolicy
      })
    }
  }
}

function watchablePanes(
  worktreeId: string,
  tab: ParkableTerminalTabModel
): Map<string, ParkedTerminalPaneCapture> {
  const state = useAppStore.getState()
  const restorePolicy = parkRestorePolicyFromState(state)
  return new Map(
    parkedTerminalTabCoverage(worktreeId, tab).panes.flatMap((pane) =>
      pane.ptyId &&
      isTerminalLeafId(pane.leafId) &&
      isParkRestorableTerminalPty(pane.ptyId, worktreeId, restorePolicy)
        ? [[pane.ptyId, pane] as const]
        : []
    )
  )
}

/** Defer whole-tab close while parked split siblings survive; no PaneManager can promote them. Collapse per leaf and clear dead titles; single-leaf exits retain normal close parity. */
export function shouldDeferParkedPtyExitTabClose(tabId: string, ptyId: string): boolean {
  const entry = parkedWatchersByTabId.get(tabId)
  if (!entry) {
    return false
  }
  const paneId = entry.paneIdByPtyId.get(ptyId)
  if (paneId !== undefined) {
    useAppStore.getState().clearRuntimePaneTitle(tabId, paneId)
  }
  const remaining = entry.disposersByPtyId.size
  if (remaining === 0) {
    if (paneId !== undefined) {
      // Why: empty entry is the pinned-close tombstone; the reveal-mounted pane owns the exit, so suppress once and drop it.
      parkedWatchersByTabId.delete(tabId)
      return true
    }
    return false
  }
  // Why: runs before the sidecar removes the dead watcher, so >1 (or an unwatched PTY) means live siblings remain.
  const defer = remaining > 1 || !entry.disposersByPtyId.has(ptyId)
  if (defer) {
    collapseParkedExitedLeaf(tabId, ptyId)
  }
  return defer
}

function disposeClosedParkedTabWatchers(
  tabId: string,
  entry: { paneIdByPtyId: ReadonlyMap<string, number> }
): void {
  // Why: a queued pinned-close may close the tab first, leaving no pane to drain retained frames.
  for (const ptyId of entry.paneIdByPtyId.keys()) {
    discardPreHandlerPtyState(ptyId)
  }
  for (const paneId of entry.paneIdByPtyId.values()) {
    useAppStore.getState().clearRuntimePaneTitle(tabId, paneId)
  }
  disposeParkedTabWatchers(tabId)
}

/** One workspace's rendered parked verdict, as the batch pass consumes it. */
export type ParkedTerminalTabWatcherSyncEntry = {
  tabs: readonly ParkableTerminalTabModel[]
  parkedTabIds: ReadonlySet<string>
  /** Parked-equivalent tabs whose pane has not restored the current title. */
  restoreTitleOnStartTabIds?: ReadonlySet<string>
}

function startOrReconcileParkedTabWatchers(
  worktreeId: string,
  entry: ParkedTerminalTabWatcherSyncEntry
): void {
  for (const tab of entry.tabs) {
    if (!entry.parkedTabIds.has(tab.id)) {
      continue
    }
    let watcherEntry = parkedWatchersByTabId.get(tab.id)
    if (watcherEntry && watcherEntry.worktreeId !== worktreeId) {
      disposeParkedTabWatchers(tab.id)
      watcherEntry = undefined
    }
    const restoreTitleOnRegister = entry.restoreTitleOnStartTabIds?.has(tab.id) === true
    if (watcherEntry) {
      reconcileParkedTabWatchers(worktreeId, tab, watcherEntry, restoreTitleOnRegister)
    } else {
      startParkedTabWatchers(worktreeId, tab, restoreTitleOnRegister)
    }
  }
}

/** Reconcile only addressed workspace buckets; unrelated watchers and captures retain their owners. */
export function syncParkedTerminalTabWatchersForWorkspaces(
  entriesByWorktreeId: ReadonlyMap<string, ParkedTerminalTabWatcherSyncEntry>
): void {
  for (const [worktreeId, entry] of entriesByWorktreeId) {
    const liveTabIds = new Set(entry.tabs.map((tab) => tab.id))
    for (const tabId of Array.from(parkedWatchersByTabId.workspaceTabIds(worktreeId))) {
      const watcherEntry = parkedWatchersByTabId.get(tabId)
      if (!watcherEntry) {
        continue
      }
      if (!liveTabIds.has(tabId)) {
        disposeClosedParkedTabWatchers(tabId, watcherEntry)
      } else if (!entry.parkedTabIds.has(tabId) && watcherEntry.disposersByPtyId.size > 0) {
        disposeParkedTabWatchers(tabId)
      }
    }
    for (const tabId of Array.from(capturedPanesByTabId.workspaceTabIds(worktreeId))) {
      if (!liveTabIds.has(tabId)) {
        retireParkedTerminalTab(tabId)
      }
    }
    startOrReconcileParkedTabWatchers(worktreeId, entry)
  }
}

/** Sync from committed render effects so disposal shares reveal’s flush before PTY data, and start follows park unmount. */
export function syncParkedTerminalTabWatchers(args: {
  worktreeId: string
  tabs: readonly ParkableTerminalTabModel[]
  parkedTabIds: ReadonlySet<string>
  /** Parked-equivalent tabs whose pane has not restored the current title. */
  restoreTitleOnStartTabIds?: ReadonlySet<string>
}): void {
  syncParkedTerminalTabWatchersForWorkspaces(
    new Map([
      [
        args.worktreeId,
        {
          tabs: args.tabs,
          parkedTabIds: args.parkedTabIds,
          ...(args.restoreTitleOnStartTabIds
            ? { restoreTitleOnStartTabIds: args.restoreTitleOnStartTabIds }
            : {})
        }
      ]
    ])
  )
}
