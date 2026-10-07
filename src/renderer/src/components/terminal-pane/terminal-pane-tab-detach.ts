import { toast } from 'sonner'
import type { AppState } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalLeafMoveRequest } from '../../../../shared/terminal-leaf-move'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import type { PaneCwdEntry } from './resolve-split-cwd'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
export {
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-tab-strip-drop-target'
export type { TerminalTabStripDropTarget } from './terminal-tab-strip-drop-target'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'closeTab'
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

function reportMoveFailed(): void {
  toast.error(translate('terminal.paneMove.failed', "Couldn't move the pane to a new tab."))
}

type DetachTerminalPaneToTabArgs = {
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
  worktreeId: string
}

// Leaves whose move main is committing; a repeat drop meanwhile is a no-op.
const leavesMovingToNewTab = new Set<string>()

/**
 * Moves a pane into a new tab. Main commits the move (leaf, binding and pane-keyed records) before
 * the target tab exists here, so the moved pane's reattach never races a second owner (STA-9259).
 * Once main has moved it, this window only rolls forward: it never asks main to put it back.
 */
export async function detachTerminalPaneToTab(
  args: DetachTerminalPaneToTabArgs
): Promise<DetachedTerminalPaneTab | null> {
  const leafId = args.manager?.getLeafId(args.sourcePaneId)
  if (!leafId || leavesMovingToNewTab.has(leafId)) {
    return null
  }
  leavesMovingToNewTab.add(leafId)
  try {
    return await moveLeafToNewTab(args, leafId)
  } finally {
    leavesMovingToNewTab.delete(leafId)
  }
}

async function moveLeafToNewTab(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): Promise<DetachedTerminalPaneTab | null> {
  const initialStore = args.getStore()
  const targetGroupExists =
    initialStore.groupsByWorktree[args.worktreeId]?.some(
      (group) => group.id === args.targetGroupId
    ) ?? false
  if (!args.manager || !targetGroupExists || args.manager.getPanes().length <= 1) {
    return null
  }
  const persistedPtyId =
    initialStore.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId]
  const cwdDeferred = Boolean(
    args.sourcePaneCwd?.pendingCwd || args.sourcePaneCwd?.deferredSplitSpawn
  )
  // Why: a spawn result landing after the move binds SOURCE:leaf, and that bind grafts the leaf
  // back into the source tab beside its moved copy.
  if ((cwdDeferred || args.sourceConnectPending) && !persistedPtyId && !args.livePtyId) {
    return null
  }

  args.persistLayoutSnapshot()
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    targetTabId: createBrowserUuid(),
    leafId,
    ptyId: args.livePtyId ?? persistedPtyId ?? null
  }
  const answer = await window.api.pty.moveLeafToNewTab(request).catch((error: unknown) => {
    console.warn('[terminal-pane-detach] main did not answer the move', error)
    return null
  })
  if (answer?.status === 'moved') {
    return applyMove(args, request, true, answer.ptyId)
  }
  if (answer?.status === 'not_held') {
    return applyMove(args, request, false, request.ptyId)
  }
  // A failed write rolls main back; one whose outcome is unknown faults persistence, and the next
  // load converges on whichever side main kept.
  console.warn('[terminal-pane-detach] main did not move the pane', answer)
  reportMoveFailed()
  return null
}

/** Applies the move here; the pane is found by its leaf, since its pane id may have changed. */
function applyMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest,
  mainMoved: boolean,
  ptyId: string | null
): DetachedTerminalPaneTab | null {
  const { leafId, sourceTabId, targetTabId, worktreeId } = request
  const { manager } = args
  const panes = manager?.getPanes() ?? []
  const paneId = panes.find((pane) => manager?.getLeafId(pane.id) === leafId)?.id
  const sourceLayout = args.getStore().terminalLayoutsByTabId[sourceTabId]
  // A sibling closed meanwhile, so the pane takes the whole source layout and the source tab closes.
  const lastPane = panes.length === 1
  const split = lastPane ? null : detachTerminalLayoutLeaf(sourceLayout, leafId)
  const movedLayout = lastPane ? sourceLayout : split?.detachedLayout
  // Why: remove the renderer pane only after the layout handoff is computed; the close callback
  // detaches listeners but must not kill the PTY.
  if (
    !manager ||
    paneId === undefined ||
    !movedLayout ||
    (!lastPane && !manager.detachPaneForExternalMove(paneId))
  ) {
    // Why: the pane or its tab is gone here (or would not detach), so the tab main moved it into
    // holds nothing; close it the way any tab close reaches main.
    if (mainMoved) {
      commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId: targetTabId }, 'cleanup')
    }
    return null
  }
  const detachedLayout = ptyId
    ? { ...movedLayout, ptyIdsByLeafId: { ...movedLayout.ptyIdsByLeafId, [leafId]: ptyId } }
    : movedLayout

  const latestStore = args.getStore()
  const sourceShellOverride = latestStore.tabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === sourceTabId
  )?.shellOverride
  const tab = latestStore.createTab(worktreeId, args.targetGroupId, sourceShellOverride, {
    id: targetTabId,
    activate: true,
    ...(detachedLayout.chatLeafId ? { viewMode: 'chat' as const } : {}),
    initialPtyId: ptyId ?? undefined,
    ...(!ptyId
      ? {
          pendingActivationSpawn: true,
          ...(args.sourcePaneCwd?.cwd ? { startupCwd: args.sourcePaneCwd.cwd } : {})
        }
      : { initialLeafId: leafId }),
    recordInteraction: true
  })
  const afterCreateStore = args.getStore()
  moveCreatedTabToIndex({
    groupId: args.targetGroupId,
    store: afterCreateStore,
    tabId: tab.id,
    targetIndex: args.targetIndex,
    worktreeId
  })
  if (split) {
    afterCreateStore.setTabLayout(sourceTabId, split.sourceLayout)
  }
  afterCreateStore.setTabLayout(tab.id, detachedLayout)
  afterCreateStore.syncPaneDetachPtyOwnership({
    detachedLeafId: leafId,
    detachedPtyId: ptyId,
    sourceLayout: split?.sourceLayout ?? { root: null, activeLeafId: null, expandedLeafId: null },
    sourceTabId,
    targetTabId: tab.id
  })
  if (!split) {
    // The new tab reattaches the PTY, so the source tab's close must not kill it.
    afterCreateStore.closeTab(sourceTabId, {
      reason: 'cleanup',
      recordInteraction: false,
      captureRecentlyClosed: false,
      localPtyTeardownOwnedExternally: true
    })
  }
  afterCreateStore.setActiveTab(tab.id)
  afterCreateStore.setActiveTabType('terminal', worktreeId)

  return { tab, leafId, ptyId }
}
