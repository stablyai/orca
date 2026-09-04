import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'

type TabMovePaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'activeWorktreeId' | 'getActiveTab' | 'unifiedTabsByWorktree' | 'groupsByWorktree'
>

export type TabPaneColumnMoveTarget = {
  worktreeId: string
  unifiedTabId: string
  groupId: string
}

/** Rejects single-tab groups because splitting their only tab is a layout no-op. */
function resolveTabPaneColumnMoveTargetInWorktree(
  state: TabMovePaneColumnState,
  worktreeId: string,
  unifiedTabId: string,
  groupId: string
): TabPaneColumnMoveTarget | null {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === unifiedTabId && candidate.groupId === groupId
  )
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  // Why: dropUnifiedTab rejects splitting a group's only tab, so unavailable commands fall through.
  if (!tab || !group || group.tabOrder.length < 2) {
    return null
  }
  return { worktreeId, unifiedTabId, groupId }
}

/** Resolves worktree ownership once so execution and web mirroring share one target. */
export function resolveTabPaneColumnMoveTarget(
  state: TabMovePaneColumnState,
  unifiedTabId: string,
  groupId: string
): TabPaneColumnMoveTarget | null {
  const worktreeId = Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
    tabs.some((candidate) => candidate.id === unifiedTabId && candidate.groupId === groupId)
  )?.[0]
  return worktreeId
    ? resolveTabPaneColumnMoveTargetInWorktree(state, worktreeId, unifiedTabId, groupId)
    : null
}

/** Resolves the active unified tab rather than the terminal entity id stored globally. */
export function resolveActiveTabPaneColumnMoveTarget(
  state: TabMovePaneColumnState
): TabPaneColumnMoveTarget | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const tab = state.getActiveTab(worktreeId)
  return tab
    ? resolveTabPaneColumnMoveTargetInWorktree(state, worktreeId, tab.id, tab.groupId)
    : null
}

/** Mirrors only accepted local moves so paired web state cannot diverge. */
export function moveTabToNewPaneColumn(args: {
  target: TabPaneColumnMoveTarget
  direction: TabSplitDirection
}): boolean {
  const state = useAppStore.getState()
  const target = resolveTabPaneColumnMoveTarget(
    state,
    args.target.unifiedTabId,
    args.target.groupId
  )
  if (!target || target.worktreeId !== args.target.worktreeId) {
    return false
  }
  const moved = state.dropUnifiedTab(target.unifiedTabId, {
    groupId: target.groupId,
    splitDirection: args.direction
  })
  if (moved) {
    mirrorWebRuntimeTabMove({
      kind: 'split',
      worktreeId: target.worktreeId,
      tabId: target.unifiedTabId,
      targetGroupId: target.groupId,
      splitDirection: args.direction
    })
  }
  return moved
}
