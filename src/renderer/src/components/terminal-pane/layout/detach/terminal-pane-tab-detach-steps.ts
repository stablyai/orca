import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import type { PaneCwdEntry } from '../split/resolve-split-cwd'
import { paneMoveReadiness } from './terminal-pane-move-readiness'
import { isTerminalTabShown, type TerminalTabShownState } from './terminal-tab-shown'

export type TerminalPaneTabDetachStore = TerminalTabShownState &
  Pick<
    AppState,
    | 'closeTab'
    | 'createTab'
    | 'groupsByWorktree'
    | 'reorderUnifiedTabs'
    | 'setActiveTab'
    | 'setActiveTabType'
    | 'setTabCustomTitle'
    | 'setTabLayout'
    | 'syncPaneDetachPtyOwnership'
    | 'tabsByWorktree'
    | 'terminalLayoutsByTabId'
  >

export type TerminalPaneTabDetachManager = {
  getPanes: () => readonly { id: number }[]
  getLeafId: (paneId: number) => string | null
  detachPaneForExternalMove: (paneId: number) => boolean
}

type SourcePaneCwd = Pick<PaneCwdEntry, 'cwd' | 'deferredSplitSpawn' | 'pendingCwd'> &
  Partial<Pick<PaneCwdEntry, 'confirmed'>>

/** A pane's binding as its manager has it now. */
export type SourcePaneBinding = {
  livePtyId: string | null
  sourcePaneCwd?: SourcePaneCwd
  connectPending: boolean
}

/**
 * One reading of the moving pane: the tab's current manager, the leaf's pane in it, and that pane's
 * binding, all taken at once. A remount can replace the manager and a reconnect can rebind the leaf
 * while the move waits, so every step takes a fresh sample and acts only on it.
 */
export type SourcePaneSample = SourcePaneBinding & {
  manager: TerminalPaneTabDetachManager
  paneId: number
  paneCount: number
  persistedPtyId: string | null
}

export type DetachedTerminalPaneTab = {
  tab: TerminalTab
  leafId: string
  ptyId: string | null
  /** The new tab was shown, because the user still had the source tab in front of them. */
  followed: boolean
}

/**
 * Where a pane's new tab goes. `afterTabId` places it right after that tab, wherever that tab is
 * when the order is written; `index` is the drop gap. `targetTabId` names a tab another client
 * already drew.
 */
export type TerminalPaneNewTabTarget = {
  groupId: string
  index?: number
  afterTabId?: string
  targetTabId?: string
}

export type DetachTerminalPaneToNewTab = (
  sourcePaneId: number,
  target: TerminalPaneNewTabTarget
) => Promise<DetachedTerminalPaneTab | null>

export type DetachTerminalPaneToTabArgs = {
  getStore: () => TerminalPaneTabDetachStore
  /** The tab's pane manager now; a remount replaces it. */
  getManager: () => TerminalPaneTabDetachManager | null
  /** A pane's binding now, read from the same manager's transports and cwd records. */
  readPane: (paneId: number) => SourcePaneBinding
  persistLayoutSnapshot: () => void
  sourcePaneId: number
  sourceTabId: string
  targetGroupId: string
  targetIndex?: number
  /** The unified tab the new one goes right after (the menu, shortcut and palette path). */
  afterTabId?: string
  /** The new tab's id when another client already drew the tab; else one is minted. */
  targetTabId?: string
  worktreeId: string
}

export function sampleSourcePane(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): SourcePaneSample | null {
  const manager = args.getManager()
  const panes = manager?.getPanes() ?? []
  const paneId = panes.find((pane) => manager?.getLeafId(pane.id) === leafId)?.id
  if (!manager || paneId === undefined) {
    return null
  }
  return {
    ...args.readPane(paneId),
    manager,
    paneId,
    paneCount: panes.length,
    persistedPtyId:
      args.getStore().terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId] ?? null
  }
}

/** The PTY the move carries: the pane's live binding, else the saved one. */
export function boundPtyId(sample: SourcePaneSample): string | null {
  return sample.livePtyId ?? sample.persistedPtyId
}

function findGroup(store: TerminalPaneTabDetachStore, worktreeId: string, groupId: string) {
  return store.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)
}

/**
 * The pane can move now: it is in a split, with a PTY or a spawn that can follow it, and the
 * destination group still exists. Returns the sample the move must act on.
 */
export function sampleIfReadyToMove(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): SourcePaneSample | null {
  if (!findGroup(args.getStore(), args.worktreeId, args.targetGroupId)) {
    return null
  }
  const sample = sampleSourcePane(args, leafId)
  return sample && paneMoveReadiness(sample) === 'ready' ? sample : null
}

/** The user has this worktree's source terminal tab in front of them. */
export function isSourceTabShown(args: DetachTerminalPaneToTabArgs): boolean {
  return isTerminalTabShown(args.getStore(), args.worktreeId, args.sourceTabId)
}

/** Where a group's unpinned tabs begin; the moved pane's tab is never pinned, so it goes no earlier. */
export function firstUnpinnedIndex(
  store: Pick<TerminalPaneTabDetachStore, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  groupId: string,
  excludeTabId?: string
): number {
  const order = (
    store.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)?.tabOrder ?? []
  ).filter((id) => id !== excludeTabId)
  const pinnedIds = new Set(
    (store.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.isPinned)
      .map((tab) => tab.id)
  )
  const first = order.findIndex((id) => !pinnedIds.has(id))
  return first === -1 ? order.length : first
}

/**
 * The legal gap for the new tab in the group's order as it is now: right after its anchor tab if it
 * has one still in the group, else the requested gap; never ahead of a pinned tab.
 */
export function newTabIndexNow(
  store: Pick<TerminalPaneTabDetachStore, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  target: { worktreeId: string; groupId: string; index?: number; afterTabId?: string },
  excludeTabId?: string
): number | undefined {
  const order = (
    store.groupsByWorktree[target.worktreeId]?.find((group) => group.id === target.groupId)
      ?.tabOrder ?? []
  ).filter((id) => id !== excludeTabId)
  const anchorAt = target.afterTabId ? order.indexOf(target.afterTabId) : -1
  const requested = anchorAt === -1 ? target.index : anchorAt + 1
  if (requested === undefined) {
    return undefined
  }
  const pinnedEnd = firstUnpinnedIndex(store, target.worktreeId, target.groupId, excludeTabId)
  return Math.min(Math.max(requested, pinnedEnd), order.length)
}

export function moveCreatedTabToIndex(args: {
  store: TerminalPaneTabDetachStore
  tabId: string
  target: { worktreeId: string; groupId: string; index?: number; afterTabId?: string }
  /** Main placed the new tab at this index itself. */
  mainPlaced: boolean
}): void {
  const group = findGroup(args.store, args.target.worktreeId, args.target.groupId)
  // Re-read at write time: a tab pinned or moved while the move was in flight is respected.
  const insertionIndex = newTabIndexNow(args.store, args.target, args.tabId)
  if (!group || insertionIndex === undefined) {
    return
  }
  const nextOrder = (group.tabOrder ?? []).filter((id) => id !== args.tabId)
  nextOrder.splice(insertionIndex, 0, args.tabId)
  args.store.reorderUnifiedTabs(args.target.groupId, nextOrder, {
    recordInteraction: false,
    layoutOwnerHandled: args.mainPlaced
  })
}

/**
 * Where the new tab goes when it is created: the requested group, or, for a move main already
 * committed whose group closed meanwhile, right after the source tab in the source's group.
 */
export function resolveDestination(
  args: DetachTerminalPaneToTabArgs,
  committed: boolean
): { groupId: string; index?: number; afterTabId?: string } | null {
  const store = args.getStore()
  if (findGroup(store, args.worktreeId, args.targetGroupId)) {
    return {
      groupId: args.targetGroupId,
      ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {}),
      ...(args.afterTabId ? { afterTabId: args.afterTabId } : {})
    }
  }
  if (!committed) {
    return null
  }
  const sourceRow = store.unifiedTabsByWorktree[args.worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === args.sourceTabId
  )
  return sourceRow && findGroup(store, args.worktreeId, sourceRow.groupId)
    ? { groupId: sourceRow.groupId, afterTabId: sourceRow.id }
    : null
}

/**
 * The window names the tab it drew after the pane it carries, as main and a host do in their
 * commit. Idempotent: a tab already named (by this or by the user since) keeps its name.
 */
export function nameTabAfterPane(
  store: TerminalPaneTabDetachStore,
  moved: { targetTabId: string; leafId: string },
  worktreeId: string
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const tab = store.tabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === moved.targetTabId
  )
  const paneTitle =
    store.terminalLayoutsByTabId[moved.targetTabId]?.titlesByLeafId?.[moved.leafId]?.trim()
  if (tab && paneTitle && !tab.customTitle) {
    store.setTabCustomTitle(tab.id, paneTitle, { recordInteraction: false })
  }
}
