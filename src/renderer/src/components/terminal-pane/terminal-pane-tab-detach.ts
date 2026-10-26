import { toast } from 'sonner'
import type { AppState } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalLeafMoveRequest } from '../../../../shared/terminal-leaf-move'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import type { PaneCwdEntry } from './resolve-split-cwd'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { moveLeafThroughLayoutOwner } from './terminal-pane-detach-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import {
  moveWebRuntimeLeafToNewTab,
  resolvePaneMoveHost,
  settleHostPaneMove
} from '@/runtime/web-runtime-leaf-move'
import { resolveHostTabDropTarget } from '@/runtime/web-runtime-session-tab-move'
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

/** Main commits leaf/binding/pane records before target tab creation so reattach cannot race another owner (STA-9259). After commitment the window only rolls forward. */
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
  // A late source spawn would bind SOURCE:leaf and graft the moved leaf back beside its duplicate.
  if ((cwdDeferred || args.sourceConnectPending) && !persistedPtyId && !args.livePtyId) {
    return null
  }

  const livePtyId = args.livePtyId ?? persistedPtyId ?? null
  const paneMoveHost =
    !ORCA_LAYOUT_OWNER_IS_MAIN && livePtyId !== null && isWebTerminalSurfaceTabId(args.sourceTabId)
      ? await resolvePaneMoveHost(args.worktreeId)
      : null
  args.persistLayoutSnapshot()
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    // Why: a mirrored host tab's local id derives from the host id, so the next snapshot finds this tab.
    targetTabId: paneMoveHost
      ? toWebTerminalSurfaceTabId(createBrowserUuid())
      : createBrowserUuid(),
    leafId,
    ptyId: livePtyId
  }
  if (paneMoveHost) {
    const placement = await resolveHostTabDropTarget(paneMoveHost, {
      worktreeId: args.worktreeId,
      tabId: request.targetTabId,
      targetGroupId: args.targetGroupId,
      ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {})
    })
    // Why: the host's snapshot push can land before its reply and would leave nothing to detach, so
    // the window moves first. The call is dispatched before the move's layout pushes, so the host
    // sees the move first.
    const hostMove = moveWebRuntimeLeafToNewTab(paneMoveHost, request, placement)
    const applied = applyMove(args, request, false, request.ptyId)
    void hostMove
      .then((outcome) => settleHostPaneMove(paneMoveHost, request, outcome, applied !== null))
      .catch((error: unknown) => console.warn('[terminal-pane-detach] move not settled', error))
    return applied
  }
  // Switch point: main moves the pane and names the new tab.
  const answer = await (
    ORCA_LAYOUT_OWNER_IS_MAIN
      ? moveLeafThroughLayoutOwner(
          request,
          { groupId: args.targetGroupId, index: args.targetIndex },
          args.sourcePaneCwd?.cwd
        )
      : window.api.pty.moveLeafToNewTab(request)
  ).catch((error: unknown) => {
    console.warn('[terminal-pane-detach] main did not answer the move', error)
    return null
  })
  if (answer?.status === 'moved') {
    const moved =
      ORCA_LAYOUT_OWNER_IS_MAIN && answer.tabId
        ? { ...request, targetTabId: answer.tabId }
        : request
    return applyMove(args, moved, true, answer.ptyId)
  }
  if (answer?.status === 'not_held') {
    return applyMove(args, request, false, request.ptyId)
  }
  // Failed persistence rolls main back; unknown outcomes fault persistence and reload converges on main’s committed side.
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
  // Compute handoff before removing the source pane; its close must detach listeners without killing the PTY.
  if (
    !manager ||
    paneId === undefined ||
    !movedLayout ||
    (!lastPane && !manager.detachPaneForExternalMove(paneId))
  ) {
    // If source removal failed or the pane/tab vanished, close main’s otherwise-empty target through normal tab-close routing.
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
  // Switch point: the reply runs after the frame with main's new tab, which may have drawn it.
  const frameDrawn =
    ORCA_LAYOUT_OWNER_IS_MAIN && mainMoved
      ? latestStore.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === targetTabId)
      : undefined
  const tab =
    frameDrawn ??
    latestStore.createTab(worktreeId, args.targetGroupId, sourceShellOverride, {
      id: targetTabId,
      ...(isWebTerminalSurfaceTabId(targetTabId) ? { mirroredHostTab: true } : {}),
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
  // Main's frame drew the tab where main placed it; the window places it only when it drew it.
  if (!frameDrawn) {
    moveCreatedTabToIndex({
      groupId: args.targetGroupId,
      store: afterCreateStore,
      tabId: tab.id,
      targetIndex: args.targetIndex,
      worktreeId,
      mainPlaced: mainMoved
    })
  }
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
