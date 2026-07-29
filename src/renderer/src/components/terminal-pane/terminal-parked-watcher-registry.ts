/**
 * Parked terminal watcher registry (store-free bookkeeping).
 *
 * Why a separate module: shutdownWorktreeTerminals (a store slice) must
 * synchronously dispose parked watchers, but the watcher lifecycle module
 * imports the store — a slice importing it would re-enter store creation
 * mid-evaluation. Keeping the maps and pure disposal here lets the slice
 * import cycle-free, mirroring how pty-dispatcher exports its handler maps.
 */
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'

export type ParkedTerminalPaneCapture = {
  ptyId: string | null
  /** PaneManager numeric pane id the live pane used for runtime titles. */
  paneId: number
  /** Stable terminal-layout leaf UUID (paneKey attribution). */
  leafId: string
  drivesTabTitle: boolean
}

export type CapturedTabPanes = { worktreeId: string; panes: ParkedTerminalPaneCapture[] }

export const capturedPanesByTabId = new Map<string, CapturedTabPanes>()

// Why: PaneManager pane ids die with the unmounted pane, but the watcher must
// keep writing the exact runtime-title slots the live pane used — a different
// slot would strand a stale "working" title that pins worktree status.
// TerminalPane unmount records the identities here for the park wiring.
export function captureParkedTerminalPaneCandidates(
  tabId: string,
  worktreeId: string,
  panes: ParkedTerminalPaneCapture[]
): void {
  capturedPanesByTabId.set(tabId, { worktreeId, panes })
}

export type ParkedTabWatcherEntry = {
  worktreeId: string
  /** Tab-level ptyId at watcher start; a change means the PTY was re-minted
   *  (e.g. wake respawn) and the watchers must restart against fresh ids. */
  tabPtyId: string | null
  /** Runtime-title slot each watcher writes, so parked PTY-exit handling can
   *  clear the dead leaf's slot (no live pane will ever overwrite it). */
  paneIdByPtyId: Map<string, number>
  disposersByPtyId: Map<string, () => void>
}

export const parkedWatchersByTabId = new Map<string, ParkedTabWatcherEntry>()

export function getParkedTerminalWatcherTabIds(): string[] {
  return Array.from(parkedWatchersByTabId.keys())
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
  // Why: explicit tab retirement permanently invalidates both live parked
  // observers and unmounted-pane candidates; neither may reattach later.
  disposeParkedTabWatchers(tabId)
  capturedPanesByTabId.delete(tabId)
}

/**
 * Synchronously disposes any parked watcher subscribed to these PTYs.
 * Shutdown transactionally suspends dispatcher sidecars before teardown, then
 * disposes their watchers only after commit. The tab entries remain so a
 * sleeping parked tab cannot restart against stale PTY ids; wake re-mints the
 * ids and the sync path restarts watchers then.
 */
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
  // Why: removal unregisters sidecars before PTY kill finishes. Tombstone each
  // old PTY now so its delayed final flush/exit cannot refill bounded buffers
  // after this worktree loses every future pane consumer.
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
      capturedPanesByTabId.delete(tabId)
    }
  }
}
