import type { AppState } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PaneCwdEntry } from './resolve-split-cwd'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
export {
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-tab-strip-drop-target'
export type { TerminalTabStripDropTarget } from './terminal-tab-strip-drop-target'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'createTab'
  | 'groupsByWorktree'
  | 'reorderUnifiedTabs'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'setTabLayout'
  | 'syncPaneDetachPtyOwnership'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>

type TerminalPaneTabDetachManager = {
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
}

function withDetachedPtyFallback(args: {
  leafId: string
  ptyId: string | null
  detachedLayout: NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout']
}): NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout'] {
  if (!args.ptyId || args.detachedLayout.ptyIdsByLeafId?.[args.leafId]) {
    return args.detachedLayout
  }
  return {
    ...args.detachedLayout,
    ptyIdsByLeafId: {
      ...args.detachedLayout.ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  }
}

function moveCreatedTabToIndex(args: {
  groupId: string
  store: TerminalPaneTabDetachStore
  tabId: string
  targetIndex: number | undefined
  worktreeId: string
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
  args.store.reorderUnifiedTabs(args.groupId, nextOrder, { recordInteraction: false })
}

export function detachTerminalPaneToTab(args: {
  fallbackPtyId?: string | null
  getStore: () => TerminalPaneTabDetachStore
  manager: TerminalPaneTabDetachManager | null
  persistLayoutSnapshot: () => void
  sourcePaneId: number
  sourcePaneCwd?: SourcePaneCwd
  sourceTabId: string
  targetGroupId: string
  targetIndex?: number
  worktreeId: string
}): DetachedTerminalPaneTab | null {
  const initialStore = args.getStore()
  const targetGroupExists =
    initialStore.groupsByWorktree[args.worktreeId]?.some(
      (group) => group.id === args.targetGroupId
    ) ?? false
  if (!args.manager || !targetGroupExists || args.manager.getPanes().length <= 1) {
    return null
  }

  const sourceLeafId = args.manager.getLeafId(args.sourcePaneId)
  if (!sourceLeafId) {
    return null
  }

  const persistedPtyId =
    initialStore.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[sourceLeafId]
  const cwdDeferred = Boolean(
    args.sourcePaneCwd?.pendingCwd || args.sourcePaneCwd?.deferredSplitSpawn
  )
  if (cwdDeferred && !persistedPtyId && !args.fallbackPtyId) {
    return null
  }

  args.persistLayoutSnapshot()
  const store = args.getStore()
  const detached = detachTerminalLayoutLeaf(
    store.terminalLayoutsByTabId[args.sourceTabId],
    sourceLeafId
  )
  if (!detached) {
    return null
  }

  const ptyId = detached.ptyId ?? args.fallbackPtyId ?? null
  const detachedLayout = withDetachedPtyFallback({
    leafId: sourceLeafId,
    ptyId,
    detachedLayout: detached.detachedLayout
  })

  // Why: remove the renderer pane only after the layout/PTY handoff has been
  // computed; the close callback detaches listeners but must not kill the PTY.
  if (!args.manager.detachPaneForExternalMove(args.sourcePaneId)) {
    return null
  }

  const latestStore = args.getStore()
  const sourceShellOverride = latestStore.tabsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === args.sourceTabId
  )?.shellOverride
  const tab = latestStore.createTab(args.worktreeId, args.targetGroupId, sourceShellOverride, {
    activate: true,
    initialPtyId: ptyId ?? undefined,
    ...(!ptyId
      ? {
          pendingActivationSpawn: true,
          ...(args.sourcePaneCwd?.cwd ? { startupCwd: args.sourcePaneCwd.cwd } : {})
        }
      : {}),
    recordInteraction: true
  })
  const afterCreateStore = args.getStore()
  moveCreatedTabToIndex({
    groupId: args.targetGroupId,
    store: afterCreateStore,
    tabId: tab.id,
    targetIndex: args.targetIndex,
    worktreeId: args.worktreeId
  })
  afterCreateStore.setTabLayout(args.sourceTabId, detached.sourceLayout)
  afterCreateStore.setTabLayout(tab.id, detachedLayout)
  afterCreateStore.syncPaneDetachPtyOwnership({
    detachedLeafId: sourceLeafId,
    detachedPtyId: ptyId,
    sourceLayout: detached.sourceLayout,
    sourceTabId: args.sourceTabId,
    targetTabId: tab.id
  })
  afterCreateStore.setActiveTab(tab.id)
  afterCreateStore.setActiveTabType('terminal')

  return { tab, leafId: sourceLeafId, ptyId }
}
