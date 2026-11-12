import {
  isTerminalNoticeLifetimeCurrent,
  type TerminalNoticeLifetime
} from '../../provider-notices/terminal-notice-lifetime'
/** Store-free registry/disposal lets shutdown slices stop watchers synchronously without re-entering store initialization through the watcher lifecycle import. */
import { WorkspaceParkedTerminalRegistry } from './workspace-parked-terminal-registry'
import { invalidateTerminalParkingInputs } from '../terminal-parking-input-events'
import type { NotificationWorkspaceOwner } from '../../../../../../shared/notification-source'
import {
  discardPreHandlerPtyState,
  hasPreHandlerPtyExit
} from '../../pty-transport/delivery/pty-pre-handler-buffer'
import { parseRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { releaseTerminalScrollIntentKey } from '../../../../lib/pane-manager/terminal-scroll/terminal-scroll-intent-key-store'

export type ParkedTerminalPaneCapture = {
  noticeLifetime?: TerminalNoticeLifetime
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

const captureRevisions = new Map<string, number>()
const captureTabIdsByPtyId = new Map<string, Set<string>>()
const captureTabIdsByEnvironmentId = new Map<string, Set<string>>()

function updateCaptureMembership(tabId: string, capture: CapturedTabPanes, add: boolean): void {
  for (const pane of capture.panes) {
    if (!pane.ptyId) {
      continue
    }
    const environmentId = parseRemoteRuntimePtyId(pane.ptyId)?.environmentId
    for (const [index, key] of [
      [captureTabIdsByPtyId, pane.ptyId],
      [captureTabIdsByEnvironmentId, environmentId]
    ] as const) {
      if (!key) {
        continue
      }
      if (add) {
        let ids = index.get(key)
        if (!ids) {
          index.set(key, (ids = new Set()))
        }
        ids.add(tabId)
      } else {
        const ids = index.get(key)
        ids?.delete(tabId)
        if (ids?.size === 0) {
          index.delete(key)
        }
      }
    }
  }
}

export function capturedTerminalWorkspacesForPtyIds(ptyIds: Iterable<string>): Set<string> {
  return capturedWorkspaceIds(captureTabIdsByPtyId, ptyIds)
}

export function capturedTerminalWorkspacesForEnvironmentIds(ids: Iterable<string>): Set<string> {
  return capturedWorkspaceIds(captureTabIdsByEnvironmentId, ids)
}

function capturedWorkspaceIds(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  keys: Iterable<string>
) {
  const worktreeIds = new Set<string>()
  for (const key of keys) {
    for (const tabId of index.get(key) ?? []) {
      const capture = capturedPanesByTabId.get(tabId)
      if (capture) {
        worktreeIds.add(capture.worktreeId)
      }
    }
  }
  return worktreeIds
}
export const capturedPanesByTabId = new WorkspaceParkedTerminalRegistry<CapturedTabPanes>(
  (tabId, worktreeId, previous, next) => {
    if (previous) {
      updateCaptureMembership(tabId, previous, false)
    }
    if (next) {
      updateCaptureMembership(tabId, next, true)
    }
    if (capturedPanesByTabId.has(tabId)) {
      captureRevisions.set(tabId, (captureRevisions.get(tabId) ?? 0) + 1)
    } else {
      captureRevisions.delete(tabId)
    }
    invalidateTerminalParkingInputs(worktreeId)
  }
)

export function parkedTerminalCaptureRevision(tabId: string): number {
  return captureRevisions.get(tabId) ?? 0
}

// Capture original runtime-title slots before numeric IDs disappear on unmount, or stale working titles can pin status.
export function captureParkedTerminalPaneCandidates(
  tabId: string,
  worktreeId: string,
  panes: ParkedTerminalPaneCapture[]
): void {
  const previous = new Map(
    capturedPanesByTabId.get(tabId)?.panes.map((pane) => [pane.leafId, pane])
  )
  for (const pane of panes) {
    const prior = previous.get(pane.leafId)?.noticeLifetime
    if (
      !pane.noticeLifetime &&
      prior &&
      prior.ptyId === pane.ptyId &&
      isTerminalNoticeLifetimeCurrent(prior)
    ) {
      pane.noticeLifetime = prior
    }
  }
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

export const parkedWatchersByTabId = new WorkspaceParkedTerminalRegistry<ParkedTabWatcherEntry>()
const watcherTabIdsByPtyId = new Map<string, Set<string>>()

export function retainParkedWatcherPty(tabId: string, ptyId: string): () => void {
  let tabIds = watcherTabIdsByPtyId.get(ptyId)
  if (!tabIds) {
    watcherTabIdsByPtyId.set(ptyId, (tabIds = new Set()))
  }
  tabIds.add(tabId)
  return () => {
    tabIds.delete(tabId)
    if (tabIds.size === 0) {
      watcherTabIdsByPtyId.delete(ptyId)
    }
  }
}

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
  captureRevisions.delete(tabId)
}

/** Dispose sidecars only after shutdown commits; retain tab entries against stale-ID restarts until wake remints IDs. */
export function disposeParkedTerminalWatchersForPtyIds(ptyIds: readonly string[]): void {
  for (const ptyId of ptyIds) {
    for (const tabId of Array.from(watcherTabIdsByPtyId.get(ptyId) ?? [])) {
      const entry = parkedWatchersByTabId.get(tabId)
      const dispose = entry?.disposersByPtyId.get(ptyId)
      entry?.disposersByPtyId.delete(ptyId)
      dispose?.()
    }
  }
}

export function disposeParkedTerminalWatchersForWorktree(
  worktreeId: string,
  options?: { consumePreHandlerState?: boolean }
): void {
  for (const tabId of Array.from(parkedWatchersByTabId.workspaceTabIds(worktreeId))) {
    const entry = parkedWatchersByTabId.get(tabId)
    if (!entry) {
      continue
    }
    if (options?.consumePreHandlerState) {
      disposeRemovedWorktreeParkedTabWatchers(tabId, entry)
    } else {
      disposeParkedTabWatchers(tabId)
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

export function retireParkedTerminalWorktree(worktreeId: string): void {
  disposeRemovedWorktreeParkedTerminalWatchers(worktreeId)
  for (const tabId of Array.from(capturedPanesByTabId.workspaceTabIds(worktreeId))) {
    retireParkedTerminalTab(tabId)
  }
}

/** Cold workspace-catalog replacement only; normal removals retire their addressed workspace. */
export function pruneParkedTerminalWatchers(liveWorktreeIds: ReadonlySet<string>): void {
  const registeredIds = new Set([
    ...parkedWatchersByTabId.workspaceIds(),
    ...capturedPanesByTabId.workspaceIds()
  ])
  for (const worktreeId of registeredIds) {
    if (!liveWorktreeIds.has(worktreeId)) {
      retireParkedTerminalWorktree(worktreeId)
    }
  }
}
