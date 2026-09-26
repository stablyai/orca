import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import type { useAppStore } from '@/store'
import { listTerminalPtyPaneOwners } from './terminal-pty-pane-owner'
import { findTerminalTabRow } from './terminal-tab-row-lookup'
import type {
  LiveTerminalSurfaceOwner,
  LiveTerminalSurfaceOwnerIndex
} from './worktree-live-terminal-surface-owners'

export type LiveSurfaceAdoptionStore = Pick<
  ReturnType<typeof useAppStore.getState>,
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

/** Bind one host-owned PTY to the surface the host names for it; false when none could be named. */
function adoptHostOwnedSurface(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  owner: LiveTerminalSurfaceOwner,
  materializedTabIds: Set<string>
): boolean {
  const store = getState()
  const known = tabExists(store, owner.tabId)
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

/**
 * Whether some pane in this renderer already shows the PTY. Ownership is tab-keyed, so a row
 * filed under any other worktree key still counts — a PTY already surfaced must not be adopted
 * twice. A layout whose row is gone surfaces nothing, so it counts for neither.
 */
function isPtyAlreadySurfaced(store: LiveSurfaceAdoptionStore, ptyId: string): boolean {
  return listTerminalPtyPaneOwners(store, ptyId).some(
    (owner) => findTerminalTabRow(store, owner.tabId) !== null
  )
}

/**
 * Give every live workspace PTY the surface that already owns it, minting one
 * only for a PTY proven to have none.
 *
 * `surfaced` is whether any live PTY ends the sweep holding a surface. False means the
 * workspace has live agents but nothing the user can look at — the caller owes them a
 * seeded pane, because failing closed must not also fail silent. `declinedPtyIds` names
 * the live PTYs the sweep left without one, so a decline is diagnosable and not mute.
 */
export async function adoptLiveWorkspacePtySurfaces(
  getState: () => LiveSurfaceAdoptionStore,
  worktreeId: string,
  livePtyIds: readonly string[],
  listSurfaceOwners: (worktreeId: string) => Promise<LiveTerminalSurfaceOwnerIndex | null>
): Promise<{ surfaced: boolean; declinedPtyIds: string[] }> {
  const unbound = livePtyIds.filter((ptyId) => !isPtyAlreadySurfaced(getState(), ptyId))
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
  for (const ptyId of unbound) {
    // Why: a pane can mount while the census is in flight, so the pre-RPC
    // verdict is stale by the time it would authorize a mint.
    if (isPtyAlreadySurfaced(getState(), ptyId)) {
      surfaced = true
      continue
    }
    const owner = surfaceOwners?.get(ptyId)
    if (owner) {
      if (adoptHostOwnedSurface(getState, worktreeId, owner, materializedTabIds)) {
        surfaced = true
      } else {
        declinedPtyIds.push(ptyId)
      }
      continue
    }
    // Why: only the execution host can prove a live PTY is unowned, and minting
    // on anything weaker forks a running agent onto a second empty surface.
    if (!surfaceOwners || surfaceOwners.has(ptyId)) {
      declinedPtyIds.push(ptyId)
      continue
    }
    getState().createTab(worktreeId, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    surfaced = true
  }
  return { surfaced, declinedPtyIds }
}
