import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import type { PaneCwdEntry } from '../split/resolve-split-cwd'
import { paneMoveReadiness } from './terminal-pane-move-readiness'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'activeTabId'
  | 'activeTabType'
  | 'activeWorktreeId'
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
  | 'unifiedTabsByWorktree'
>

export type TerminalPaneTabDetachManager = {
  getPanes: () => readonly { id: number }[]
  getLeafId: (paneId: number) => string | null
  detachPaneForExternalMove: (paneId: number) => boolean
}

type SourcePaneCwd = Pick<PaneCwdEntry, 'cwd' | 'deferredSplitSpawn' | 'pendingCwd'> &
  Partial<Pick<PaneCwdEntry, 'confirmed'>>

/** The source pane's live state, read fresh at each step: a reconnect can rebind it mid-move. */
export type SourcePaneState = {
  livePtyId: string | null
  sourcePaneCwd?: SourcePaneCwd
  connectPending: boolean
}

export type DetachedTerminalPaneTab = {
  tab: TerminalTab
  leafId: string
  ptyId: string | null
  /** The new tab was shown, because the user still had the source tab in front of them. */
  followed: boolean
}

/** Where a pane's new tab goes; `targetTabId` names a tab another client already drew. */
export type TerminalPaneNewTabTarget = { groupId: string; index?: number; targetTabId?: string }

export type DetachTerminalPaneToNewTab = (
  sourcePaneId: number,
  target: TerminalPaneNewTabTarget
) => Promise<DetachedTerminalPaneTab | null>

export type DetachTerminalPaneToTabArgs = {
  /** The PTY the source pane's transport is attached to now; it outranks the saved layout. */
  livePtyId?: string | null
  getStore: () => TerminalPaneTabDetachStore
  manager: TerminalPaneTabDetachManager | null
  persistLayoutSnapshot: () => void
  sourcePaneId: number
  sourcePaneCwd?: SourcePaneCwd
  /** The pane's transport is still awaiting its PTY id from a spawn or reattach. */
  sourceConnectPending?: boolean
  sourceTabId: string
  targetGroupId: string
  targetIndex?: number
  /** The new tab's id when another client already drew the tab; else one is minted. */
  targetTabId?: string
  worktreeId: string
  /** Reads the leaf's pane as it is now; without it the values above, captured at invocation, are used. */
  readSource?: (leafId: string) => SourcePaneState | null
}

export function currentSourcePane(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): SourcePaneState | null {
  if (args.readSource) {
    return args.readSource(leafId)
  }
  return {
    livePtyId: args.livePtyId ?? null,
    ...(args.sourcePaneCwd ? { sourcePaneCwd: args.sourcePaneCwd } : {}),
    connectPending: args.sourceConnectPending ?? false
  }
}

/** The PTY the move carries: the pane's live binding, else the saved one. */
export function sourcePtyId(args: DetachTerminalPaneToTabArgs, leafId: string): string | null {
  return (
    currentSourcePane(args, leafId)?.livePtyId ??
    args.getStore().terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId] ??
    null
  )
}

/** The user has this worktree's source terminal tab in front of them (not a browser or editor tab). */
export function isSourceTabShown(args: DetachTerminalPaneToTabArgs): boolean {
  const store = args.getStore()
  return (
    store.activeWorktreeId === args.worktreeId &&
    store.activeTabType === 'terminal' &&
    store.activeTabId === args.sourceTabId
  )
}

export function moveCreatedTabToIndex(args: {
  groupId: string
  store: TerminalPaneTabDetachStore
  tabId: string
  targetIndex: number | undefined
  worktreeId: string
  /** Main placed the new tab at this index itself. */
  mainPlaced: boolean
}): void {
  if (args.targetIndex === undefined) {
    return
  }
  const group = args.store.groupsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === args.groupId
  )
  if (!group) {
    return
  }
  const orderWithoutCreatedTab = (group.tabOrder ?? []).filter((id) => id !== args.tabId)
  // Re-read at write time: a tab pinned while the move was in flight still comes first.
  const pinnedEnd = firstUnpinnedIndex(args.store, args.worktreeId, args.groupId, args.tabId)
  const insertionIndex = Math.min(
    Math.max(args.targetIndex, pinnedEnd),
    orderWithoutCreatedTab.length
  )
  const nextOrder = [...orderWithoutCreatedTab]
  nextOrder.splice(insertionIndex, 0, args.tabId)
  args.store.reorderUnifiedTabs(args.groupId, nextOrder, {
    recordInteraction: false,
    layoutOwnerHandled: args.mainPlaced
  })
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

export function indexAfterPinnedTabs(
  store: TerminalPaneTabDetachStore,
  worktreeId: string,
  groupId: string,
  index: number | undefined
): number | undefined {
  return index === undefined
    ? undefined
    : Math.max(index, firstUnpinnedIndex(store, worktreeId, groupId))
}

export function nameTabAfterPane(
  store: TerminalPaneTabDetachStore,
  moved: { targetTabId: string; leafId: string },
  args: Pick<DetachTerminalPaneToTabArgs, 'targetTabId' | 'worktreeId'>
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN || args.targetTabId) {
    return
  }
  const tab = store.tabsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === moved.targetTabId
  )
  const paneTitle =
    store.terminalLayoutsByTabId[moved.targetTabId]?.titlesByLeafId?.[moved.leafId]?.trim()
  // Idempotent: a tab already named (by this or by the user since) keeps its name.
  if (tab && paneTitle && !tab.customTitle) {
    store.setTabCustomTitle(tab.id, paneTitle, { recordInteraction: false })
  }
}

/** The pane is still here, in a split with a PTY or a spawn that can follow it, and its group still exists. */
export function canMoveNow(args: DetachTerminalPaneToTabArgs, leafId: string): boolean {
  const store = args.getStore()
  const manager = args.manager
  const paneId = manager?.getPanes().find((pane) => manager.getLeafId(pane.id) === leafId)?.id
  const targetGroupExists =
    store.groupsByWorktree[args.worktreeId]?.some((group) => group.id === args.targetGroupId) ??
    false
  const source = currentSourcePane(args, leafId)
  if (!manager || paneId === undefined || !targetGroupExists || !source) {
    return false
  }
  return (
    paneMoveReadiness({
      paneCount: manager.getPanes().length,
      livePtyId: source.livePtyId,
      persistedPtyId: store.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId],
      sourcePaneCwd: source.sourcePaneCwd,
      connectPending: source.connectPending
    }) === 'ready'
  )
}
