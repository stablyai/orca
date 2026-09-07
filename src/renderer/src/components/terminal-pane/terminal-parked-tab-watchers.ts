/**
 * Parked terminal tab watcher lifecycle.
 *
 * Why: parking unmounts a tab's TerminalPane, so its PTYs lose the renderer byte
 * parsers. This module runs a pane-less byte watcher per PTY while parked and
 * disposes them on reveal, tab close, PTY exit, or worktree teardown.
 */
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty'
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'
import { terminalProviderHasAuthoritativeSnapshot } from '../terminal/terminal-provider-snapshot-capability'
import {
  isParkRestorableTerminalPty,
  selectPairedRuntimeParkingEnvironmentIds,
  type TerminalParkRestorePolicy
} from './terminal-hidden-view-parking'
import {
  reconcileParkedWatcherPtyIds,
  resolveParkedTerminalPaneCandidates,
  type ParkableTerminalTabModel
} from './terminal-parked-watcher-reconciliation'
import { collapseParkedExitedLeaf, startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId,
  type ParkedTabWatcherEntry,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

// Why: re-export so callers keep one import surface; the registry split only breaks the store-slice import cycle.
export {
  captureParkedTerminalPaneCandidates,
  collectParkedTerminalWatcherPtyIds,
  disposeAllParkedTerminalWatchers,
  disposeRemovedWorktreeParkedTerminalWatchers,
  disposeParkedTerminalWatchersForPtyIds,
  disposeParkedTerminalWatchersForWorktree,
  getParkedTerminalWatcherTabIds,
  pruneParkedTerminalWatchers,
  terminalWatcherLiveWorkspaceIds
} from './terminal-parked-watcher-registry'
export type { ParkedTerminalPaneCapture } from './terminal-parked-watcher-registry'
export {
  fallbackParkedPaneCandidates,
  resolveParkedTerminalPaneCandidates
} from './terminal-parked-watcher-reconciliation'
export type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'
export type ParkedTerminalPtyEligibility = (ptyId: string) => boolean

const allowOrdinaryParkRestore = (ptyId: string): boolean =>
  isRemoteExecutionHostPtyId(ptyId) || terminalProviderHasAuthoritativeSnapshot(ptyId)

// Why: fact-mode watchers work for any pty whose bytes transit local main —
// SSH included — so watcher coverage follows the park-restore policy, not the
// stricter daemon-snapshot predicate.
function parkRestorePolicyFromState(state: {
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: { capabilities?: readonly string[] } | null | undefined }
  >
}): TerminalParkRestorePolicy {
  return {
    sshParkingEnabled: state.settings?.terminalSshViewParking !== false,
    pairedRuntimeParkingEnvironmentIds: selectPairedRuntimeParkingEnvironmentIds(
      state.runtimeStatusByEnvironmentId
    )
  }
}

/**
 * Whether parked byte watchers can fully cover this tab's PTYs (every candidate
 * has a park-restorable PTY on a valid leaf). Hosts must refuse to park a tab
 * that fails this check, or bell/title/completion side effects silently drop.
 */
export function canWatcherCoverParkedTerminalTab(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  // Why: paired and SSH restore through their own policy; local parking must not
  // unmount a pane whose preserved daemon can only return a lossy snapshot.
  isPtyEligible: ParkedTerminalPtyEligibility = allowOrdinaryParkRestore
): boolean {
  const state = useAppStore.getState()
  const panes = resolveParkedTerminalPaneCandidates(tab, state)
  const restorePolicy = parkRestorePolicyFromState(state)
  return (
    panes.length > 0 &&
    panes.every(
      (pane) =>
        pane.ptyId !== null &&
        isTerminalLeafId(pane.leafId) &&
        isParkRestorableTerminalPty(pane.ptyId, worktreeId, restorePolicy) &&
        isPtyEligible(pane.ptyId)
    )
  )
}

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
  for (const pane of resolveParkedTerminalPaneCandidates(tab, useAppStore.getState())) {
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
    resolveParkedTerminalPaneCandidates(tab, state).flatMap((pane) =>
      pane.ptyId &&
      isTerminalLeafId(pane.leafId) &&
      isParkRestorableTerminalPty(pane.ptyId, worktreeId, restorePolicy)
        ? [[pane.ptyId, pane] as const]
        : []
    )
  )
}

/**
 * Called from hosts' onPtyExit before closing the tab; returns true to defer.
 * A parked tab has no PaneManager to promote split siblings, so the live exit
 * path would close the whole tab and kill surviving siblings — reveal remount
 * handles dead PTYs per leaf instead. Single-leaf tabs return false to keep
 * exit→closeTab parity. Also clears the dead leaf's runtime-title slot.
 */
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
    const watcherEntry = parkedWatchersByTabId.get(tab.id)
    const restoreTitleOnRegister = entry.restoreTitleOnStartTabIds?.has(tab.id) === true
    if (watcherEntry) {
      reconcileParkedTabWatchers(worktreeId, tab, watcherEntry, restoreTitleOnRegister)
    } else {
      startParkedTabWatchers(worktreeId, tab, restoreTitleOnRegister)
    }
  }
}

/**
 * Reconciles watchers for every rendered workspace in one pass.
 *
 * Why batched: the per-worktree entry point scans both registries in full, so
 * the terminal host calling it once per workspace made a single effect fire
 * cost surfaces x registry map iterations. Walking each registry once and then
 * doing the per-tab start/reconcile pass is O(registry + tabs) instead.
 *
 * The dispose/start decisions are identical: registry entries are keyed by tab
 * id and every tab belongs to exactly one worktree, so hoisting the dispose and
 * capture-cleanup sweeps ahead of every start only reorders work across
 * disjoint tab sets.
 */
export function syncParkedTerminalTabWatchersForWorkspaces(
  entriesByWorktreeId: ReadonlyMap<string, ParkedTerminalTabWatcherSyncEntry>
): void {
  if (entriesByWorktreeId.size === 0) {
    return
  }
  // Why lazy: only worktrees that actually own a registry row need the id set,
  // so an idle profile allocates none of them.
  const liveTabIdsByWorktreeId = new Map<string, ReadonlySet<string>>()
  const liveTabIdsFor = (worktreeId: string): ReadonlySet<string> | null => {
    const cached = liveTabIdsByWorktreeId.get(worktreeId)
    if (cached) {
      return cached
    }
    const entry = entriesByWorktreeId.get(worktreeId)
    if (!entry) {
      return null
    }
    const liveTabIds = new Set(entry.tabs.map((tab) => tab.id))
    liveTabIdsByWorktreeId.set(worktreeId, liveTabIds)
    return liveTabIds
  }
  for (const [tabId, watcherEntry] of parkedWatchersByTabId) {
    const entry = entriesByWorktreeId.get(watcherEntry.worktreeId)
    if (!entry) {
      continue
    }
    const liveTabIds = liveTabIdsFor(watcherEntry.worktreeId)
    if (!liveTabIds?.has(tabId)) {
      disposeClosedParkedTabWatchers(tabId, watcherEntry)
      continue
    }
    if (!entry.parkedTabIds.has(tabId) && watcherEntry.disposersByPtyId.size > 0) {
      disposeParkedTabWatchers(tabId)
    }
  }
  // Why: closed tabs never park/reveal again; drop captures to keep the registry bounded.
  for (const [tabId, capture] of capturedPanesByTabId) {
    const liveTabIds = liveTabIdsFor(capture.worktreeId)
    if (liveTabIds && !liveTabIds.has(tabId)) {
      capturedPanesByTabId.delete(tabId)
    }
  }
  for (const [worktreeId, entry] of entriesByWorktreeId) {
    startOrReconcileParkedTabWatchers(worktreeId, entry)
  }
}

/**
 * Reconciles watchers for one worktree against its rendered parked set.
 * Run from an effect keyed on committed render state so disposal shares the
 * reveal remount's flush (before PTY data IPC) and start follows the park unmount.
 */
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
