/**
 * Parked terminal watcher registry (store-free bookkeeping).
 *
 * Why a separate module: shutdownWorktreeTerminals (a store slice) must
 * synchronously dispose parked watchers, but the watcher lifecycle module
 * imports the store — a slice importing it would re-enter store creation
 * mid-evaluation. Keeping the maps and pure disposal here lets the slice
 * import cycle-free, mirroring how pty-dispatcher exports its handler maps.
 */
import { discardPreHandlerPtyState, hasPreHandlerPtyExit } from './pty-pre-handler-buffer'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

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

// Why: the floating workspace is synthetic, so repo/folder surface lists never include it.
export function terminalWatcherLiveWorkspaceIds(workspaceIds: Iterable<string>): Set<string> {
  return new Set([...workspaceIds, FLOATING_TERMINAL_WORKTREE_ID])
}

/**
 * Whether this tab is parked right now — the reveal remount renders before the
 * host effect that disposes the watcher, so a pane reading this at render time
 * can tell a park-reveal from an in-place reattach. Empty entries are
 * pinned-close tombstones, not live parks.
 */
export function isTerminalTabParked(tabId: string): boolean {
  return (parkedWatchersByTabId.get(tabId)?.disposersByPtyId.size ?? 0) > 0
}

/**
 * PTYs a live parked watcher owns, and can therefore prove are still alive.
 * The runtime graph needs this to keep publishing an unmounted pane's leaf
 * (STA-2854: a dropped leaf invalidates the terminal handle every paired
 * subscriber of that terminal is bound to).
 *
 * Built in one pass and reused for a whole publication: the caller checks it
 * once per saved leaf across every tab of every worktree, so a per-PTY scan of
 * the registry would be quadratic in a large workspace. Parked tabs are NOT
 * bounded by the hot-retain limits — those bound what stays warm, not what
 * parks — so this can legitimately hold thousands of entries.
 *
 * Reads `disposersByPtyId`, never `paneIdByPtyId`: exit and per-PTY disposal
 * delete only the disposer and deliberately keep the pane-id slot so the dead
 * leaf's runtime title can still be cleared.
 *
 * Excludes remote-runtime PTYs (detected through the store-free shared id
 * module — this file must stay importable from a store slice). startParkedPtyWatcher installs no PTY-exit
 * subscription for them, and the parked fact stream carries no exit fact, so
 * their disposer outlives the terminal and proves nothing about liveness.
 *
 * Also excludes a PTY holding an unowned buffered exit. startParkedPtyWatcher
 * refuses to register one, so this only catches an exit that raced an existing
 * registration; keeping the check here costs one lookup per watched PTY.
 */
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

/**
 * Pane ids the parked watchers are actually using, by PTY.
 *
 * Read from the watcher entry rather than the unmount capture: a parked tab
 * whose layout gains a leaf gets a watcher from the layout-derived fallback,
 * which the capture never learns about. The entry covers both, so a parked leaf
 * publishes the identity main routes split/close and the paneKey fallback
 * through, and indexes the runtime-title slot the watcher writes — instead of a
 * fabricated ordinal that can name a pane PaneManager already retired.
 */
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
