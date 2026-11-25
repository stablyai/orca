import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { TerminalLeafMoveRequest } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-leaf-move'
import { commitTerminalSurfaceClose } from '@/store/terminals/retirement/terminal-surface-close-intent'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { holdTerminalPaneMount } from '../split/terminal-pane-split-request-routing'
import { moveLeafThroughLayoutOwner } from './terminal-pane-detach-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../../../shared/workspace-layout/terminal-surface-id'
import {
  isCurrentPaneMoveHost,
  moveWebRuntimeLeafToNewTab,
  resolvePaneMoveHost,
  settleHostPaneMove
} from '@/runtime/hosted-terminals/actions/web-runtime-leaf-move'
import { resolveHostTabDropTarget } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move'
import {
  boundPtyId,
  isSourceTabShown,
  moveCreatedTabToIndex,
  nameTabAfterPane,
  newTabIndexNow,
  resolveDestination,
  sampleIfReadyToMove,
  sampleSourcePane,
  type DetachedTerminalPaneTab,
  type DetachTerminalPaneToTabArgs,
  type SourcePaneSample
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
  const leafId = args.getMount()?.manager.getLeafId(args.sourcePaneId)
  if (!leafId || leavesMovingToNewTab.has(leafId)) {
    return null
  }
  leavesMovingToNewTab.add(leafId)
  // Held for the whole move: parking the source tab mid-move would unmount the pane main may
  // already have committed.
  const releaseMount = holdTerminalPaneMount(args.sourceTabId, args.worktreeId)
  try {
    return await moveLeafToNewTab(args, leafId)
  } finally {
    releaseMount()
    leavesMovingToNewTab.delete(leafId)
  }
}

async function moveLeafToNewTab(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): Promise<DetachedTerminalPaneTab | null> {
  // The user was looking at the source tab when they asked; the move follows the pane only if they still are.
  const sourceShownAtInvocation = isSourceTabShown(args)
  if (!sampleIfReadyToMove(args, leafId)) {
    return null
  }
  // A move another client asked for reports to that client; only this window's user gets a toast.
  const userInitiated = !args.targetTabId
  const refuse = (): null => {
    if (userInitiated) {
      reportMoveFailed()
    }
    return null
  }
  const hostRoute =
    !ORCA_LAYOUT_OWNER_IS_MAIN && isWebTerminalSurfaceTabId(args.sourceTabId)
      ? await resolvePaneMoveHost(args.worktreeId)
      : ({ kind: 'window' } as const)
  // Why: the host owns these tabs, so a window-only move would be undone by its next snapshot.
  if (hostRoute.kind === 'unavailable') {
    return refuse()
  }
  const paneMoveHost = hostRoute.kind === 'host' ? hostRoute.authority : null
  const followPane = (): boolean => sourceShownAtInvocation && isSourceTabShown(args)
  // Why: a mirrored host tab's local id derives from the host id, so the next snapshot finds this tab.
  const targetTabId = paneMoveHost
    ? toWebTerminalSurfaceTabId(createBrowserUuid())
    : (args.targetTabId ?? createBrowserUuid())
  const newTabTarget = {
    worktreeId: args.worktreeId,
    groupId: args.targetGroupId,
    ...(args.targetIndex !== undefined ? { index: args.targetIndex } : {}),
    ...(args.afterTabId ? { afterTabId: args.afterTabId } : {})
  }
  // The gap is read from the same order the host mapping translates, after its await.
  const placement = paneMoveHost
    ? await resolveHostTabDropTarget(paneMoveHost.environmentId, {
        worktreeId: args.worktreeId,
        tabId: targetTabId,
        targetGroupId: args.targetGroupId,
        index: (state) => newTabIndexNow(state, newTabTarget)
      })
    : null
  // The last reversible point: one reading of the pane, its binding and its destination, after
  // the last await, so the request carries the PTY the pane is bound to when it is sent.
  const source = sampleIfReadyToMove(args, leafId)
  if (!source || (paneMoveHost && !isCurrentPaneMoveHost(paneMoveHost))) {
    return null
  }
  const ptyId = boundPtyId(source)
  if (paneMoveHost && ptyId === null) {
    return refuse()
  }
  args.persistLayoutSnapshot()
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    targetTabId,
    leafId,
    ptyId
  }
  if (paneMoveHost && placement) {
    // Why: the host's snapshot push can land before its reply and would leave nothing to detach, so
    // the window moves first. The call is dispatched before the move's layout pushes, so the host
    // sees the move first. The host names the tab in its commit.
    const hostMove = moveWebRuntimeLeafToNewTab(paneMoveHost, request, placement)
    const applied = applyMove(args, request, source, {
      mainMoved: false,
      ptyId,
      speculative: true,
      follow: followPane()
    })
    void hostMove
      .then((outcome) =>
        settleHostPaneMove(
          paneMoveHost,
          request,
          outcome,
          applied !== null,
          userInitiated ? { onRefused: reportMoveFailed } : {}
        )
      )
      .catch((error: unknown) => console.warn('[terminal-pane-detach] move not settled', error))
    return applied
  }
  // Switch point: main moves the pane and names the new tab.
  const answer = await (
    ORCA_LAYOUT_OWNER_IS_MAIN
      ? moveLeafThroughLayoutOwner(
          request,
          { groupId: args.targetGroupId, index: newTabIndexNow(args.getStore(), newTabTarget) },
          source.sourcePaneCwd?.cwd
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
    // Main holds the pane now; the window rolls forward with the pane as it is after the reply.
    return nameAfterPane(
      applyMove(args, moved, sampleSourcePane(args, leafId), {
        mainMoved: true,
        ptyId: answer.ptyId,
        follow: followPane()
      }),
      args
    )
  }
  if (answer?.status === 'not_held') {
    // Main moved nothing, so the window moves the pane as it is now, or not at all.
    const current = sampleIfReadyToMove(args, leafId)
    if (!current) {
      return refuse()
    }
    const currentPtyId = boundPtyId(current)
    return nameAfterPane(
      applyMove(args, { ...request, ptyId: currentPtyId }, current, {
        mainMoved: false,
        ptyId: currentPtyId,
        follow: followPane()
      }),
      args
    )
  }
  // Failed persistence rolls main back; unknown outcomes fault persistence and reload converges on main’s committed side.
  console.warn('[terminal-pane-detach] main did not move the pane', answer)
  // A move another client asked for is refused to that client; this window's user did not drag it.
  return refuse()
}

/** Applies the move here, to the pane exactly as `source` read it (no await since). */
function applyMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest,
  source: SourcePaneSample | null,
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
  // Read before the pane leaves this layout; an unbound pane's new shell starts in its folder.
  const startupCwd = source?.sourcePaneCwd?.cwd
  const sourceLayout = args.getStore().terminalLayoutsByTabId[sourceTabId]
  // A sibling closed meanwhile, so the pane takes the whole source layout and the source tab closes.
  const lastPane = source?.paneCount === 1
  const destination = resolveDestination(args, mainMoved)
  // Why: closing the source here is outside what a refusal can undo, and the host keeps its last
  // pane anyway; the host's answer and snapshot settle this window instead.
  if (lastPane && options.speculative) {
    return null
  }
  const split = lastPane ? null : detachTerminalLayoutLeaf(sourceLayout, leafId)
  const movedLayout = lastPane ? sourceLayout : split?.detachedLayout
  // Compute handoff before removing the source pane; its close must detach listeners without killing the PTY.
  if (
    !source ||
    !destination ||
    !movedLayout ||
    (!lastPane && !source.manager.detachPaneForExternalMove(source.paneId))
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
    latestStore.createTab(worktreeId, destination.groupId, sourceShellOverride, {
      id: targetTabId,
      ...(isWebTerminalSurfaceTabId(targetTabId) ? { mirroredHostTab: true } : {}),
      activate: options.follow,
      ...(detachedLayout.chatLeafId ? { viewMode: 'chat' as const } : {}),
      initialPtyId: ptyId ?? undefined,
      ...(!ptyId
        ? {
            pendingActivationSpawn: true,
            ...(startupCwd ? { startupCwd } : {})
          }
        : { initialLeafId: leafId }),
      recordInteraction: true
    })
  const afterCreateStore = args.getStore()
  // Main's frame drew the tab where main placed it; the window places it only when it drew it.
  if (!frameDrawn) {
    moveCreatedTabToIndex({
      store: afterCreateStore,
      tabId: tab.id,
      target: { worktreeId, ...destination },
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
    nameTabAfterPane(
      args.getStore(),
      { targetTabId: moved.tab.id, leafId: moved.leafId },
      args.worktreeId
    )
  }
  return moved
}
