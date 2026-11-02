import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { useAppStore } from '@/store'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  layoutFramesHoldTerminalPane,
  layoutFrameTerminalTab
} from '@/runtime/layout-frame-terminal-panes'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { resolveTerminalTabPtyOwnership } from './terminal-tab-for-pty-id'
import type {
  LiveTerminalSurfaceOwner,
  LiveTerminalSurfaceOwnerIndex
} from './worktree-live-terminal-surface-owners'

export type LiveSurfaceAdoptionStore = WorktreeOperationRouteState &
  Pick<
    ReturnType<typeof useAppStore.getState>,
    | 'closedTerminalTabTombstonesByTabId'
    | 'createTab'
    | 'ptyIdsByTabId'
    | 'setTabLayout'
    | 'tabsByWorktree'
    | 'terminalLayoutsByTabId'
    | 'updateTabPtyId'
    | 'replaceTerminalLayoutPanePtyId'
  >

function layoutContainsLeaf(
  root: LiveSurfaceAdoptionStore['terminalLayoutsByTabId'][string]['root'],
  leafId: string
): boolean {
  if (!root) {
    return false
  }
  return root.type === 'leaf'
    ? root.leafId === leafId
    : layoutContainsLeaf(root.first, leafId) || layoutContainsLeaf(root.second, leafId)
}

export function bindLivePtyToExactSurface(
  store: LiveSurfaceAdoptionStore,
  worktreeId: string,
  terminal: { paneKey: string; ptyId: string; tabId: string }
): boolean {
  const pane = parsePaneKey(terminal.paneKey)
  if (!pane || pane.tabId !== terminal.tabId) {
    return false
  }
  const ownerEntries = Object.entries(store.tabsByWorktree).flatMap(([ownerWorktreeId, tabs]) =>
    tabs.filter((tab) => tab.id === terminal.tabId).map((tab) => ({ ownerWorktreeId, tab }))
  )
  const competingBinding = Object.entries(store.ptyIdsByTabId).some(
    ([tabId, ptyIds]) => tabId !== terminal.tabId && ptyIds.includes(terminal.ptyId)
  )
  if (ownerEntries.length > 1 || competingBinding) {
    return false
  }
  const existing = ownerEntries[0]
  if (existing) {
    const layout = store.terminalLayoutsByTabId[terminal.tabId]
    if (
      !worktreeIdsEqual(existing.ownerWorktreeId, worktreeId) ||
      !layoutContainsLeaf(layout?.root ?? null, pane.leafId)
    ) {
      return false
    }
    store.updateTabPtyId(terminal.tabId, terminal.ptyId)
    store.replaceTerminalLayoutPanePtyId(terminal.tabId, pane.leafId, terminal.ptyId)
    return true
  }
  const created = store.createTab(worktreeId, undefined, undefined, {
    id: terminal.tabId,
    initialLeafId: pane.leafId,
    initialPtyId: terminal.ptyId,
    activate: false,
    recordInteraction: false
  })
  return created.id === terminal.tabId
}

function tabExists(store: LiveSurfaceAdoptionStore, tabId: string): boolean {
  return Object.values(store.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

/** Rebind host-unowned PTYs to recorded panes still free here, recreating a missing unclosed tab under its recorded id; minting would duplicate surfaces. */
function bindToRecordedSurface(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  recorded: LiveTerminalSurfaceOwner,
  materializedTabIds: Set<string>
): boolean {
  const store = getState()
  const pane = parsePaneKey(recorded.paneKey)
  if (!pane) {
    return false
  }
  const heldPtyId = store.terminalLayoutsByTabId[recorded.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  if (heldPtyId && heldPtyId !== recorded.ptyId) {
    return false
  }
  if (tabExists(store, recorded.tabId) && !materializedTabIds.has(recorded.tabId)) {
    return bindLivePtyToExactSurface(store, worktreeId, recorded)
  }
  // Why: a fresh id duplicates the tab on the client that made it; main refuses closed tab ids.
  return (
    !hasClosedTerminalTabRecord(store.closedTerminalTabTombstonesByTabId, recorded.tabId) &&
    adoptHostOwnedSurface(getState, worktreeId, recorded, materializedTabIds)
  )
}

/** Bind one host-owned PTY to the surface the host names for it; false when none could be named. */
function adoptHostOwnedSurface(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  owner: LiveTerminalSurfaceOwner,
  materializedTabIds: Set<string>
): boolean {
  const store = getState()
  const known = tabExists(store, owner.tabId)
  // Switch point, a paired server's workspace (the gate blocks those before any sweep today; a
  // local one returns before this): frames draw the server's pane; the window makes none.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && !known) {
    return framesShowRecordedPane(worktreeId, owner)
  }
  if (bindLivePtyToExactSurface(store, worktreeId, owner)) {
    if (!known) {
      materializedTabIds.add(owner.tabId)
    }
    return true
  }
  const pane = parsePaneKey(owner.paneKey)
  // Why: a tab this sweep materialized carries only the one host leaf it was
  // minted with, so the host's later panes need a leaf rather than no surface.
  if (!pane || !materializedTabIds.has(owner.tabId)) {
    return false
  }
  const current = getState()
  const layout = current.terminalLayoutsByTabId[owner.tabId]
  if (!layout?.root) {
    return false
  }
  current.setTabLayout(owner.tabId, {
    ...layout,
    root: {
      type: 'split',
      direction: 'horizontal',
      first: layout.root,
      second: { type: 'leaf', leafId: pane.leafId }
    },
    ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [pane.leafId]: owner.ptyId }
  })
  current.updateTabPtyId(owner.tabId, owner.ptyId)
  return true
}

/** Whether main's frames show the terminal in the pane main recorded for it. */
function framesShowRecordedPane(worktreeId: string, recorded: LiveTerminalSurfaceOwner): boolean {
  const pane = parsePaneKey(recorded.paneKey)
  return (
    pane?.tabId === recorded.tabId &&
    layoutFramesHoldTerminalPane(worktreeId, { ...recorded, leafId: pane.leafId })
  )
}

/** Whether main holds the terminal bound in the pane it recorded, drawn by this window yet or not. */
function mainHoldsRecordedPane(worktreeId: string, recorded: LiveTerminalSurfaceOwner): boolean {
  const pane = parsePaneKey(recorded.paneKey)
  return Boolean(
    pane?.tabId === recorded.tabId &&
    layoutFrameTerminalTab(worktreeId, recorded.tabId)?.terminal?.panes.some(
      (held) => held.leafId === pane.leafId && held.ptyId === recorded.ptyId
    )
  )
}

/** Reuse proven PTY surfaces, minting only after host proves no owner. surfaced=false returns seeding responsibility when live agents remain invisible; declinedPtyIds makes refusal diagnosable. */
export async function adoptLiveWorkspacePtySurfaces(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  livePtyIds: readonly string[],
  listSurfaceOwners: (worktreeId: string) => Promise<LiveTerminalSurfaceOwnerIndex | null>
): Promise<{ surfaced: boolean; declinedPtyIds: string[] }> {
  // Include persisted layout/tab.ptyId bindings; mounted-only ptyIdsByTabId misses dormant surfaces.
  const unbound = livePtyIds.filter(
    (ptyId) => resolveTerminalTabPtyOwnership(getState(), worktreeId, ptyId).kind === 'none'
  )
  let surfaced = unbound.length < livePtyIds.length
  const declinedPtyIds: string[] = []
  if (unbound.length === 0) {
    return { surfaced, declinedPtyIds }
  }
  let surfaceOwners: LiveTerminalSurfaceOwnerIndex | null
  try {
    surfaceOwners = await listSurfaceOwners(worktreeId)
  } catch {
    surfaceOwners = null
  }
  const materializedTabIds = new Set<string>()
  // Why: an unowned PTY's recorded pane is only a hint, so PTYs the host names as owners bind first.
  const isUnowned = (ptyId: string): boolean => {
    const owner = surfaceOwners?.get(ptyId)
    return Boolean(owner && 'unowned' in owner)
  }
  for (const ptyId of [...unbound.filter((id) => !isUnowned(id)), ...unbound.filter(isUnowned)]) {
    // Recheck after RPC: panes can mount and bind while census is in flight.
    if (resolveTerminalTabPtyOwnership(getState(), worktreeId, ptyId).kind !== 'none') {
      surfaced = true
      continue
    }
    const owner = surfaceOwners?.get(ptyId)
    // Only execution-host proof permits minting; weaker ownership evidence forks live agents onto empty surfaces.
    if (!owner) {
      declinedPtyIds.push(ptyId)
      continue
    }
    const mainPlaces =
      ORCA_LAYOUT_OWNER_IS_MAIN && runtimeEnvironmentIdUnlessTwin(getState(), worktreeId) === null
    // Main places unshown terminals before answering, so its named pane/frame owns presentation. Window writes nothing; paired servers retain their existing path.
    if (mainPlaces && !('unowned' in owner)) {
      surfaced = true
      continue
    }
    if (!('unowned' in owner)) {
      if (adoptHostOwnedSurface(getState, worktreeId, owner, materializedTabIds)) {
        surfaced = true
      } else {
        declinedPtyIds.push(ptyId)
      }
      continue
    }
    // Switch point: one main could not place stays unshown, unless main's frames already show it
    // in the pane main recorded (main's graph not yet reinstalled when it answered).
    if (mainPlaces) {
      if (owner.recorded && mainHoldsRecordedPane(worktreeId, owner.recorded)) {
        surfaced = true
      } else {
        declinedPtyIds.push(ptyId)
      }
      continue
    }
    surfaced = true
    if (
      owner.recorded &&
      bindToRecordedSurface(getState, worktreeId, owner.recorded, materializedTabIds)
    ) {
      continue
    }
    // A recorded tab createTab had to mint under another id already holds this PTY.
    if (resolveTerminalTabPtyOwnership(getState(), worktreeId, ptyId).kind !== 'none') {
      continue
    }
    getState().createTab(worktreeId, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
  }
  return { surfaced, declinedPtyIds }
}
