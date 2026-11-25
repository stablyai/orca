import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import type { PaneCwdEntry } from '../split/resolve-split-cwd'
import { paneMoveReadiness } from './terminal-pane-move-readiness'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'activeTabId'
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
  const insertionIndex = Math.min(Math.max(args.targetIndex, 0), orderWithoutCreatedTab.length)
  const nextOrder = [...orderWithoutCreatedTab]
  nextOrder.splice(insertionIndex, 0, args.tabId)
  args.store.reorderUnifiedTabs(args.groupId, nextOrder, {
    recordInteraction: false,
    layoutOwnerHandled: args.mainPlaced
  })
}

/** The moved pane's tab is never pinned, so it lands no earlier than the first unpinned slot. */
export function indexAfterPinnedTabs(
  store: TerminalPaneTabDetachStore,
  worktreeId: string,
  groupId: string,
  index: number | undefined
): number | undefined {
  if (index === undefined) {
    return undefined
  }
  const order =
    store.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)?.tabOrder ?? []
  const pinnedIds = new Set(
    (store.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.isPinned)
      .map((tab) => tab.id)
  )
  const firstUnpinned = order.findIndex((id) => !pinnedIds.has(id))
  return Math.max(index, firstUnpinned === -1 ? order.length : firstUnpinned)
}

/**
 * The pane's own name is what made it findable, so its new tab starts with it (copied, not linked).
 * The client that asked for the move names the tab; its rename reaches this window through the owner.
 * Switch point: main's rename frame redraws the moved pane without its title; main should name the tab.
 */
export function nameTabAfterPane(
  store: TerminalPaneTabDetachStore,
  moved: DetachedTerminalPaneTab,
  args: Pick<DetachTerminalPaneToTabArgs, 'targetTabId' | 'worktreeId'>
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN || args.targetTabId) {
    return
  }
  const tab = store.tabsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === moved.tab.id
  )
  const paneTitle =
    store.terminalLayoutsByTabId[moved.tab.id]?.titlesByLeafId?.[moved.leafId]?.trim()
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
  if (!manager || paneId === undefined || !targetGroupExists) {
    return false
  }
  return (
    paneMoveReadiness({
      paneCount: manager.getPanes().length,
      livePtyId: args.livePtyId,
      persistedPtyId: store.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId],
      sourcePaneCwd: args.sourcePaneCwd,
      connectPending: args.sourceConnectPending ?? false
    }) === 'ready'
  )
}
