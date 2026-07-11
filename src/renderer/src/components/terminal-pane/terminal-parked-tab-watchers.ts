/**
 * Parked terminal tab watcher lifecycle.
 *
 * Why: parking unmounts a tab's TerminalPane, so its PTYs lose the renderer
 * byte parsers. This module owns the pane-less replacement: it remembers the
 * unmounted panes' identities (pane id / leaf id), starts one
 * parked-terminal-byte-watcher per PTY when a tab parks, and disposes them on
 * reveal, tab close, PTY exit, or worktree teardown. The bookkeeping maps
 * live in terminal-parked-watcher-registry so the terminals store slice can
 * dispose watchers without importing this store-coupled module.
 * See docs/reference/terminal-hidden-view-parking.md.
 */
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { subscribeToPtyExit } from './pty-dispatcher'
import { startParkedTerminalByteWatcher } from './parked-terminal-byte-watcher'
import { isSnapshotBackedTerminalPty } from './terminal-hidden-view-parking'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

// Why: re-exported so park wiring keeps one import surface; the registry
// split exists only to break the store-slice import cycle.
export {
  captureParkedTerminalPaneCandidates,
  disposeParkedTerminalWatchersForPtyIds,
  disposeParkedTerminalWatchersForWorktree,
  getParkedTerminalWatcherTabIds,
  pruneParkedTerminalWatchers
} from './terminal-parked-watcher-registry'
export type { ParkedTerminalPaneCapture } from './terminal-parked-watcher-registry'

export type ParkableTerminalTabModel = Pick<TerminalTab, 'id' | 'ptyId'>

type ParkedPaneFallbackState = {
  terminalLayoutsByTabId: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: ReturnType<typeof useAppStore.getState>['runtimePaneTitlesByTabId']
}

// Why: if no unmount capture exists (or it predates a PTY respawn), derive
// pane identities from the persisted layout snapshot. Numeric pane ids are
// unknown here: reuse the single existing runtime-title slot when unambiguous
// so a stale "working" title still gets overwritten, otherwise use negative
// slots that can never collide with real PaneManager ids.
export function fallbackParkedPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const leafIds = collectLeafIdsInOrder(layout?.root)
  if (leafIds.length === 0) {
    return []
  }
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
  const titleSlots = Object.keys(state.runtimePaneTitlesByTabId[tab.id] ?? {})
  const reusableSlot =
    leafIds.length === 1 && titleSlots.length === 1 ? Number(titleSlots[0]) : null
  return leafIds.map((leafId, index) => ({
    ptyId: ptyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null),
    paneId: reusableSlot ?? -(index + 1),
    leafId,
    drivesTabTitle: layout?.activeLeafId ? leafId === layout.activeLeafId : index === 0
  }))
}

// Why: unmount captures and layout fallbacks must resolve identically for the
// watcher start path and the park-eligibility coverage check, or a tab could
// pass the check and then start with different (uncoverable) candidates.
function resolveParkedTerminalPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const captured = capturedPanesByTabId.get(tab.id)
  // Why: a capture that no longer mentions the tab's current PTY is stale
  // (the PTY was re-minted since the unmount); fall back to the layout.
  const capturedIsCurrent =
    captured !== undefined &&
    captured.panes.length > 0 &&
    (tab.ptyId === null || captured.panes.some((pane) => pane.ptyId === tab.ptyId))
  return capturedIsCurrent ? captured.panes : fallbackParkedPaneCandidates(tab, state)
}

/**
 * Whether the parked byte watchers can fully cover this tab's PTYs (some
 * candidate exists and every candidate has a snapshot-backed PTY bound to a
 * valid leaf). Hosts must refuse to park a tab that fails this check —
 * parking it would silently drop bell/title/completion side effects, the
 * exact failure that sank the first parking attempt.
 */
export function canWatcherCoverParkedTerminalTab(
  worktreeId: string,
  tab: ParkableTerminalTabModel
): boolean {
  const panes = resolveParkedTerminalPaneCandidates(tab, useAppStore.getState())
  return (
    panes.length > 0 &&
    panes.every(
      (pane) =>
        pane.ptyId !== null &&
        isTerminalLeafId(pane.leafId) &&
        isSnapshotBackedTerminalPty(pane.ptyId, worktreeId)
    )
  )
}

function startParkedTabWatchers(worktreeId: string, tab: ParkableTerminalTabModel): void {
  const state = useAppStore.getState()
  const panes = resolveParkedTerminalPaneCandidates(tab, state)
  const disposersByPtyId = new Map<string, () => void>()
  const paneIdByPtyId = new Map<string, number>()
  for (const pane of panes) {
    const ptyId = pane.ptyId
    // Why: the park policy already excludes non-snapshot-backed PTYs, but the
    // tab model can change between the park decision and this effect — guard
    // again so remote-runtime/SSH PTYs never get a local watcher. Legacy
    // non-UUID leaf ids are skipped because makePaneKey throws on them.
    if (
      !ptyId ||
      disposersByPtyId.has(ptyId) ||
      !isTerminalLeafId(pane.leafId) ||
      !isSnapshotBackedTerminalPty(ptyId, worktreeId)
    ) {
      continue
    }
    const initialTitle = state.runtimePaneTitlesByTabId[tab.id]?.[pane.paneId]
    const disposeWatcher = startParkedTerminalByteWatcher({
      ptyId,
      tabId: tab.id,
      worktreeId,
      leafId: pane.leafId,
      paneId: pane.paneId,
      drivesTabTitle: pane.drivesTabTitle,
      // Why: seed the watcher's agent tracker with the pane's last known
      // title so an agent already working at park time still notifies when
      // it finishes while parked.
      ...(initialTitle !== undefined ? { initialTitle } : {}),
      // Why: no pane transport exists while parked; write straight to the
      // PTY, the same channel background agent launches use.
      sendInput: (data) => window.api.pty.write(ptyId, data)
    })
    // Why: a PTY that exits while parked has no pane to run exit cleanup; at
    // minimum its watcher must not outlive it.
    const unsubscribeExit = subscribeToPtyExit(ptyId, () => {
      // Why: while parked this sidecar is the ONLY exit observer — the hosts'
      // onPtyExit runs from a mounted TerminalPane. Run the observed-exit
      // teardown's data half here for a multi-leaf tab, or the dead leaf's
      // stale binding reattaches on reveal and the daemon re-creates the
      // exited session id as a fresh shell, resurrecting the pane.
      if (disposersByPtyId.size > 1) {
        useAppStore.getState().clearRuntimePaneTitle(tab.id, pane.paneId)
        collapseParkedExitedLeaf(tab.id, ptyId)
      }
      disposersByPtyId.get(ptyId)?.()
      disposersByPtyId.delete(ptyId)
      // Why: with the last watcher gone there is nothing left to watch or
      // dispose; dropping the entry keeps the registry bounded to parked
      // tabs that still hold live PTYs.
      const entry = parkedWatchersByTabId.get(tab.id)
      if (disposersByPtyId.size === 0 && entry?.disposersByPtyId === disposersByPtyId) {
        parkedWatchersByTabId.delete(tab.id)
      }
    })
    paneIdByPtyId.set(ptyId, pane.paneId)
    disposersByPtyId.set(ptyId, () => {
      unsubscribeExit()
      disposeWatcher()
    })
  }
  // Why: tracked even with zero watchers so parked-state introspection
  // (window.__terminalParkingDebug) reflects every parked tab.
  parkedWatchersByTabId.set(tab.id, {
    worktreeId,
    tabPtyId: tab.ptyId,
    paneIdByPtyId,
    disposersByPtyId
  })
}

/**
 * Hosts call this from their onPtyExit handlers before closing the tab.
 * Returns true when the close must be deferred: a parked tab has no
 * PaneManager to promote split siblings, so the live exit path degenerates to
 * "close the whole tab" — which would kill the surviving sibling panes. The
 * reveal remount handles dead PTYs per leaf instead. Single-leaf parked tabs
 * return false so exit→closeTab parity is preserved. Also clears the dead
 * leaf's runtime-title slot so a stale title cannot pin worktree status.
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
    return false
  }
  // Why: this runs from the PTY exit handler, before the exit sidecar above
  // removes the dead PTY's watcher — so the watcher count still includes the
  // exiting PTY. More than one watcher (or an exit for an unwatched PTY)
  // means live sibling leaves remain.
  const defer = remaining > 1 || !entry.disposersByPtyId.has(ptyId)
  if (defer) {
    collapseParkedExitedLeaf(tabId, ptyId)
  }
  return defer
}

// Why: deferring the tab close is not enough — a stale leaf binding left in
// the stored layout reattaches on reveal, and the daemon re-creates the exited
// session id as a fresh shell, resurrecting a pane whose shell already ended.
// With no PaneManager mounted, the observed-exit teardown's data half runs
// here instead: collapse the leaf out of the stored layout so the reveal
// replays only the surviving panes.
function collapseParkedExitedLeaf(tabId: string, ptyId: string): void {
  const state = useAppStore.getState()
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafId =
    capturedPanesByTabId.get(tabId)?.panes.find((pane) => pane.ptyId === ptyId)?.leafId ??
    Object.entries(layout?.ptyIdsByLeafId ?? {}).find(([, boundPtyId]) => boundPtyId === ptyId)?.[0]
  if (!leafId) {
    return
  }
  const detached = detachTerminalLayoutLeaf(layout, leafId)
  if (detached) {
    state.setTabLayout(tabId, detached.sourceLayout)
  }
}

/**
 * Reconciles watchers for one worktree against its rendered parked set.
 * Callers run this from an effect keyed on the committed render state, so
 * disposal lands in the same effect flush as a reveal remount (before any
 * PTY data IPC can be delivered) and start lands after the park unmount.
 */
export function syncParkedTerminalTabWatchers(args: {
  worktreeId: string
  tabs: readonly ParkableTerminalTabModel[]
  parkedTabIds: ReadonlySet<string>
}): void {
  const liveTabIds = new Set(args.tabs.map((tab) => tab.id))
  for (const [tabId, entry] of parkedWatchersByTabId) {
    if (entry.worktreeId !== args.worktreeId) {
      continue
    }
    if (!args.parkedTabIds.has(tabId) || !liveTabIds.has(tabId)) {
      disposeParkedTabWatchers(tabId)
    }
  }
  // Why: captures for closed tabs have no future park/reveal; drop them so
  // the registry stays bounded by live tabs.
  for (const [tabId, capture] of capturedPanesByTabId) {
    if (capture.worktreeId === args.worktreeId && !liveTabIds.has(tabId)) {
      capturedPanesByTabId.delete(tabId)
    }
  }
  for (const tab of args.tabs) {
    if (!args.parkedTabIds.has(tab.id)) {
      continue
    }
    const entry = parkedWatchersByTabId.get(tab.id)
    if (entry && entry.tabPtyId !== tab.ptyId) {
      disposeParkedTabWatchers(tab.id)
    }
    if (!parkedWatchersByTabId.has(tab.id)) {
      startParkedTabWatchers(args.worktreeId, tab)
    }
  }
}
