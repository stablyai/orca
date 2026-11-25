import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { TerminalLeafMoveRequest } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'
import { commitTerminalSurfaceClose } from '@/store/terminals/retirement/terminal-surface-close-intent'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { moveLeafThroughLayoutOwner } from './terminal-pane-detach-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../../../shared/workspace-layout/terminal-surface-id'
import {
  moveWebRuntimeLeafToNewTab,
  resolvePaneMoveHost,
  settleHostPaneMove
} from '@/runtime/hosted-terminals/actions/web-runtime-leaf-move'
import { resolveHostTabDropTarget } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move'
import {
  canMoveNow,
  indexAfterPinnedTabs,
  moveCreatedTabToIndex,
  nameTabAfterPane,
  type DetachedTerminalPaneTab,
  type DetachTerminalPaneToTabArgs
} from './terminal-pane-tab-detach-steps'

function reportMoveFailed(): void {
  toast.error(translate('terminal.paneMove.failed', "Couldn't move the pane to a new tab."))
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
  // The user was looking at the source tab when they asked; the move follows the pane only if they still are.
  const sourceShownAtInvocation = args.getStore().activeTabId === args.sourceTabId
  if (!canMoveNow(args, leafId)) {
    return null
  }
  const persistedPtyId =
    args.getStore().terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId]
  const livePtyId = args.livePtyId ?? persistedPtyId ?? null
  // A move another client asked for reports to that client; only this window's user gets a toast.
  const userInitiated = !args.targetTabId
  const hostRoute =
    !ORCA_LAYOUT_OWNER_IS_MAIN && isWebTerminalSurfaceTabId(args.sourceTabId)
      ? await resolvePaneMoveHost(args.worktreeId)
      : ({ kind: 'window' } as const)
  // Why: the host owns these tabs, so a window-only move would be undone by its next snapshot.
  if (hostRoute.kind === 'unavailable' || (hostRoute.kind === 'host' && livePtyId === null)) {
    if (userInitiated) {
      reportMoveFailed()
    }
    return null
  }
  // The host answer took a turn; the pane, its group or its binding may have changed meanwhile.
  if (!canMoveNow(args, leafId)) {
    return null
  }
  const paneMoveHost = hostRoute.kind === 'host' ? hostRoute.environmentId : null
  const targetIndex = indexAfterPinnedTabs(
    args.getStore(),
    args.worktreeId,
    args.targetGroupId,
    args.targetIndex
  )
  const placed = { ...args, targetIndex }
  const followPane = (): boolean =>
    sourceShownAtInvocation && args.getStore().activeTabId === args.sourceTabId
  args.persistLayoutSnapshot()
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    // Why: a mirrored host tab's local id derives from the host id, so the next snapshot finds this tab.
    targetTabId: paneMoveHost
      ? toWebTerminalSurfaceTabId(createBrowserUuid())
      : (args.targetTabId ?? createBrowserUuid()),
    leafId,
    ptyId: livePtyId
  }
  if (paneMoveHost) {
    const placement = await resolveHostTabDropTarget(paneMoveHost, {
      worktreeId: args.worktreeId,
      tabId: request.targetTabId,
      targetGroupId: args.targetGroupId,
      ...(targetIndex !== undefined ? { index: targetIndex } : {})
    })
    if (!canMoveNow(args, leafId)) {
      return null
    }
    // Why: the host's snapshot push can land before its reply and would leave nothing to detach, so
    // the window moves first. The call is dispatched before the move's layout pushes, so the host
    // sees the move first.
    const hostMove = moveWebRuntimeLeafToNewTab(paneMoveHost, request, placement)
    const applied = applyMove(placed, request, {
      mainMoved: false,
      ptyId: request.ptyId,
      speculative: true,
      follow: followPane()
    })
    void hostMove
      .then((outcome) =>
        settleHostPaneMove(paneMoveHost, request, outcome, applied !== null, {
          ...(userInitiated ? { onRefused: reportMoveFailed } : {}),
          // The tab is the host's only once it commits, so its name waits for that.
          onCommitted: () => applied && nameTabAfterPane(args.getStore(), applied, args)
        })
      )
      .catch((error: unknown) => console.warn('[terminal-pane-detach] move not settled', error))
    return applied
  }
  // Switch point: main moves the pane and names the new tab.
  const answer = await (
    ORCA_LAYOUT_OWNER_IS_MAIN
      ? moveLeafThroughLayoutOwner(
          request,
          { groupId: args.targetGroupId, index: targetIndex },
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
    return nameAfterPane(
      applyMove(placed, moved, { mainMoved: true, ptyId: answer.ptyId, follow: followPane() }),
      args
    )
  }
  if (answer?.status === 'not_held') {
    return nameAfterPane(
      applyMove(placed, request, { mainMoved: false, ptyId: request.ptyId, follow: followPane() }),
      args
    )
  }
  // Failed persistence rolls main back; unknown outcomes fault persistence and reload converges on main’s committed side.
  console.warn('[terminal-pane-detach] main did not move the pane', answer)
  // A move another client asked for is refused to that client; this window's user did not drag it.
  if (userInitiated) {
    reportMoveFailed()
  }
  return null
}

/** Applies the move here; the pane is found by its leaf, since its pane id may have changed. */
function applyMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest,
  options: {
    mainMoved: boolean
    ptyId: string | null
    /** Drawn before the host answers; undone if it refuses. */
    speculative?: boolean
    /** Show the new tab: the user still has the source tab in front of them. */
    follow: boolean
  }
): DetachedTerminalPaneTab | null {
  const { mainMoved, ptyId } = options
  const { leafId, sourceTabId, targetTabId, worktreeId } = request
  const { manager } = args
  const panes = manager?.getPanes() ?? []
  const paneId = panes.find((pane) => manager?.getLeafId(pane.id) === leafId)?.id
  const sourceLayout = args.getStore().terminalLayoutsByTabId[sourceTabId]
  // A sibling closed meanwhile, so the pane takes the whole source layout and the source tab closes.
  const lastPane = panes.length === 1
  // Why: closing the source here is outside what a refusal can undo, and the host keeps its last
  // pane anyway; the host's answer and snapshot settle this window instead.
  if (lastPane && options.speculative) {
    return null
  }
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
      activate: options.follow,
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
  if (options.follow) {
    afterCreateStore.setActiveTab(tab.id)
    afterCreateStore.setActiveTabType('terminal', worktreeId)
  }

  return { tab, leafId, ptyId, followed: options.follow }
}

function nameAfterPane(
  moved: DetachedTerminalPaneTab | null,
  args: DetachTerminalPaneToTabArgs
): DetachedTerminalPaneTab | null {
  if (moved) {
    nameTabAfterPane(args.getStore(), moved, args)
  }
  return moved
}
