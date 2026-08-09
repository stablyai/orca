/**
 * Parked terminal tab watcher lifecycle.
 *
 * Why: parking unmounts a tab's TerminalPane, so its PTYs lose the renderer byte
 * parsers. This module runs a pane-less byte watcher per PTY while parked and
 * disposes them on reveal, tab close, PTY exit, or worktree teardown.
 */
import { useAppStore } from '@/store'
import type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'
import type { ParkedTerminalPtyEligibility } from './terminal-parked-watcher-coverage-plan'
import { collapseParkedExitedLeaf } from './terminal-parked-pty-watcher'
import { parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import {
  planParkedTerminalTabWatcherCoverage,
  syncParkedTerminalTabWatchers,
  syncParkedTerminalTabWatchersWithAcknowledgements
} from './terminal-parked-watcher-acknowledgement'

// Why: re-export so callers keep one import surface; the registry split only breaks the store-slice import cycle.
export {
  captureParkedTerminalPaneCandidates,
  disposeAllParkedTerminalWatchers,
  disposeRemovedWorktreeParkedTerminalWatchers,
  disposeParkedTerminalWatchersForPtyIds,
  disposeParkedTerminalWatchersForWorktree,
  getParkedTerminalWatcherTabIds,
  pruneParkedTerminalWatchers,
  subscribeParkedTerminalWatcherOwnershipLoss,
  terminalWatcherLiveWorkspaceIds
} from './terminal-parked-watcher-registry'
export type {
  ParkedTerminalPaneCapture,
  ParkedTerminalWatcherOwnershipLossEvent
} from './terminal-parked-watcher-registry'
export {
  fallbackParkedPaneCandidates,
  resolveParkedTerminalPaneCandidates
} from './terminal-parked-watcher-reconciliation'
export type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'
export type { ParkedTerminalPtyEligibility } from './terminal-parked-watcher-coverage-plan'
export type { TerminalParkedWatcherCoveragePlan } from './terminal-parked-watcher-coverage-plan'
export type {
  ParkedTerminalTabWatcherSyncArgs,
  TerminalParkedWatcherSyncAcknowledgement
} from './terminal-park-episode-lease'
export {
  planParkedTerminalTabWatcherCoverage,
  syncParkedTerminalTabWatchers,
  syncParkedTerminalTabWatchersWithAcknowledgements
}

/**
 * Whether parked byte watchers can fully cover this tab's PTYs (every candidate
 * has a park-restorable PTY on a valid leaf). Hosts must refuse to park a tab
 * that fails this check, or bell/title/completion side effects silently drop.
 */
export function canWatcherCoverParkedTerminalTab(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  isPtyEligible?: ParkedTerminalPtyEligibility
): boolean {
  return (
    planParkedTerminalTabWatcherCoverage(worktreeId, tab, { isPtyEligible }).status === 'covered'
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
