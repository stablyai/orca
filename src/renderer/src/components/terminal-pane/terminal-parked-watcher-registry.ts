/** Store-free registry/disposal lets shutdown slices stop watchers synchronously without re-entering store initialization through the watcher lifecycle import. */
import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import { discardPreHandlerPtyState, hasPreHandlerPtyExit } from './pty-pre-handler-buffer'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { releaseTerminalScrollIntentKey } from '../../lib/pane-manager/terminal-scroll-intent-key-store'

export type ParkedTerminalPaneCapture = {
  workspaceOwner?: NotificationWorkspaceOwner
  ptyId: string | null
  /** PaneManager numeric pane id the live pane used for runtime titles. */
  paneId: number
  /** Stable terminal-layout leaf UUID (paneKey attribution). */
  leafId: string
  drivesTabTitle: boolean
  /** Plain captured fresh/untouched facts preserve sole-newborn exit parity without retaining the session. */
  untouchedFreshSpawn?: boolean
}

export type CapturedTabPanes = { worktreeId: string; panes: ParkedTerminalPaneCapture[] }

export const capturedPanesByTabId = new Map<string, CapturedTabPanes>()

// Capture original runtime-title slots before numeric IDs disappear on unmount, or stale working titles can pin status.
export function captureParkedTerminalPaneCandidates(
  tabId: string,
  worktreeId: string,
  panes: ParkedTerminalPaneCapture[]
): void {
  capturedPanesByTabId.set(tabId, { worktreeId, panes })
}

export type ParkedTabWatcherEntry = {
  worktreeId: string
  /** Restart watchers when tab PTY changes, including wake respawn. */
  tabPtyId: string | null
  /** Retain runtime-title slots so exits can clear dead leaves with no mounted pane. */
  paneIdByPtyId: Map<string, number>
  disposersByPtyId: Map<string, () => void>
}

export const parkedWatchersByTabId = new Map<string, ParkedTabWatcherEntry>()

export function getParkedTerminalWatcherTabIds(): string[] {
  return Array.from(parkedWatchersByTabId.keys())
}

// Why: the floating workspace is synthetic, so repo/folder surface lists never include it.
export function terminalWatcherLiveWorkspaceIds(workspaceIds: Iterable<string>): Set<string> {
  return new Set([...workspaceIds, FLOATING_TERMINAL_WORKTREE_ID])
}

/** Reveal renders before watcher disposal; nonempty watcher entries identify park-reveal, while empty pinned-close tombstones do not. */
export function isTerminalTabParked(tabId: string): boolean {
  return (parkedWatchersByTabId.get(tabId)?.disposersByPtyId.size ?? 0) > 0
}

/** Collect live disposer-backed PTYs once per publication to avoid per-leaf quadratic scans. Ignore retained pane-ID tombstones, remote-runtime watchers without exit evidence, and buffered exits racing registration; these cannot prove a published leaf alive. */
export function collectParkedTerminalWatcherPtyIds(): Set<string> {
  const ptyIds = new Set<string>()
  for (const entry of parkedWatchersByTabId.values()) {
    for (const ptyId of entry.disposersByPtyId.keys()) {
      if (parseRemoteRuntimePtyId(ptyId) === null && !hasPreHandlerPtyExit(ptyId)) {
        ptyIds.add(ptyId)
      }
    }
  }
  return ptyIds
}

/** Read actual watcher slots, including layout-added leaves absent from unmount captures; fabricated ordinals can address retired panes and wrong title slots. */
export function getParkedTerminalWatcherPaneIdsByPtyId(tabId: string): Map<string, number> {
  return new Map(parkedWatchersByTabId.get(tabId)?.paneIdByPtyId ?? [])
}

export function disposeParkedTabWatchers(tabId: string): void {
  const entry = parkedWatchersByTabId.get(tabId)
  if (!entry) {
    return
  }
  parkedWatchersByTabId.delete(tabId)
  for (const dispose of entry.disposersByPtyId.values()) {
    dispose()
  }
  entry.disposersByPtyId.clear()
}

export function retireParkedTerminalTab(tabId: string): void {
  // Explicit retirement invalidates both live watchers and captured candidates permanently.
  disposeParkedTabWatchers(tabId)
  const capture = capturedPanesByTabId.get(tabId)
  if (capture) {
    // Parked panes skip manager teardown; release strong scroll-intent keys here to prevent per-leaf leaks.
    for (const pane of capture.panes) {
      releaseTerminalScrollIntentKey(pane.leafId)
    }
    capturedPanesByTabId.delete(tabId)
  }
}

/** Dispose sidecars only after shutdown commits; retain tab entries against stale-ID restarts until wake remints IDs. */
export function disposeParkedTerminalWatchersForPtyIds(ptyIds: readonly string[]): void {
  for (const entry of parkedWatchersByTabId.values()) {
    for (const ptyId of ptyIds) {
      const dispose = entry.disposersByPtyId.get(ptyId)
      if (dispose) {
        entry.disposersByPtyId.delete(ptyId)
        dispose()
      }
    }
  }
}

export function disposeParkedTerminalWatchersForWorktree(
  worktreeId: string,
  options?: { consumePreHandlerState?: boolean }
): void {
  for (const [tabId, entry] of parkedWatchersByTabId) {
    if (entry.worktreeId === worktreeId) {
      if (options?.consumePreHandlerState) {
        disposeRemovedWorktreeParkedTabWatchers(tabId, entry)
      } else {
        disposeParkedTabWatchers(tabId)
      }
    }
  }
}

export function disposeRemovedWorktreeParkedTerminalWatchers(
  worktreeId: string,
  authoritativePtyIds: readonly string[] = []
): void {
  for (const ptyId of authoritativePtyIds) {
    discardPreHandlerPtyState(ptyId)
  }
  disposeParkedTerminalWatchersForWorktree(worktreeId, { consumePreHandlerState: true })
}

export function disposeAllParkedTerminalWatchers(): void {
  for (const tabId of Array.from(parkedWatchersByTabId.keys())) {
    disposeParkedTabWatchers(tabId)
  }
}

function disposeRemovedWorktreeParkedTabWatchers(
  tabId: string,
  entry: ParkedTabWatcherEntry
): void {
  // Tombstone before delayed final flush/exit can refill buffers after the workspace loses all consumers.
  for (const ptyId of entry.paneIdByPtyId.keys()) {
    discardPreHandlerPtyState(ptyId)
  }
  disposeParkedTabWatchers(tabId)
}

/** Drops watchers and captures for worktrees that no longer exist. */
export function pruneParkedTerminalWatchers(liveWorktreeIds: ReadonlySet<string>): void {
  for (const [tabId, entry] of parkedWatchersByTabId) {
    if (!liveWorktreeIds.has(entry.worktreeId)) {
      disposeRemovedWorktreeParkedTabWatchers(tabId, entry)
    }
  }
  for (const [tabId, capture] of capturedPanesByTabId) {
    if (!liveWorktreeIds.has(capture.worktreeId)) {
      for (const pane of capture.panes) {
        // Workspace removal can bypass parked closeTab; release its strong scroll-intent keys too.
        releaseTerminalScrollIntentKey(pane.leafId)
      }
      capturedPanesByTabId.delete(tabId)
    }
  }
}
