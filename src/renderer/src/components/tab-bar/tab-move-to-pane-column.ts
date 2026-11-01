import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'
import {
  isDesktopCreatedTabInFrameDrawnServerWorkspace,
  serverTabCount
} from '@/lib/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { dropTabThroughLayoutOwner } from '../tab-group/tab-group-layout-owner-commands'

type TabMovePaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'unifiedTabsByWorktree' | 'groupsByWorktree'
>

function canMoveTabToNewPaneColumnFromState(
  state: TabMovePaneColumnState,
  unifiedTabId: string,
  groupId: string
): boolean {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === unifiedTabId)
    if (!tab || tab.groupId !== groupId) {
      continue
    }
    const group = (state.groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === groupId
    )
    if (!group) {
      return false
    }
    // A group needs two server-owned tabs to split; desktop-only tabs cannot populate the server’s new group.
    return (
      !isDesktopCreatedTabInFrameDrawnServerWorkspace(worktreeId, unifiedTabId) &&
      serverTabCount(worktreeId, group.tabOrder) > 1
    )
  }
  return false
}

export function canMoveTabToNewPaneColumn(unifiedTabId: string, groupId: string): boolean {
  return canMoveTabToNewPaneColumnFromState(useAppStore.getState(), unifiedTabId, groupId)
}

export function moveTabToNewPaneColumn(args: {
  unifiedTabId: string
  groupId: string
  direction: TabSplitDirection
}): boolean {
  const state = useAppStore.getState()
  const worktreeId = Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
    tabs.some(
      (candidate) => candidate.id === args.unifiedTabId && candidate.groupId === args.groupId
    )
  )?.[0]
  if (!worktreeId || !canMoveTabToNewPaneColumnFromState(state, args.unifiedTabId, args.groupId)) {
    return false
  }
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    dropTabThroughLayoutOwner(worktreeId, {
      kind: 'split',
      tabId: args.unifiedTabId,
      groupId: args.groupId,
      direction: args.direction
    })
  ) {
    return true
  }
  const moved = state.dropUnifiedTab(args.unifiedTabId, {
    groupId: args.groupId,
    splitDirection: args.direction
  })
  if (moved) {
    mirrorWebRuntimeTabMove({
      kind: 'split',
      worktreeId,
      tabId: args.unifiedTabId,
      targetGroupId: args.groupId,
      splitDirection: args.direction
    })
  }
  return moved
}

export type MoveToWorktreeTarget = {
  id: string
  label: string
}

export function resolveMoveToWorktreeTargets(unifiedTabId: string): MoveToWorktreeTarget[] {
  const state = useAppStore.getState()
  const sourceWorktreeId = Object.entries(state.unifiedTabsByWorktree ?? {}).find(([, tabs]) =>
    tabs.some((candidate) => candidate.id === unifiedTabId)
  )?.[0]
  if (!sourceWorktreeId) {
    return []
  }
  const sourceRepoId = sourceWorktreeId.includes('::') ? sourceWorktreeId.split('::')[0] : null
  const worktreesByRepo = state.worktreesByRepo ?? {}
  const sameRepo: MoveToWorktreeTarget[] = []
  const otherRepos: MoveToWorktreeTarget[] = []

  for (const [repoKey, worktrees] of Object.entries(worktreesByRepo)) {
    if (!Array.isArray(worktrees)) {
      continue
    }
    for (const wt of worktrees) {
      if (!wt || wt.isArchived || wt.id === sourceWorktreeId) {
        continue
      }
      const label = wt.displayName || wt.branch?.replace(/^refs\/heads\//, '') || wt.path || wt.id
      const entry: MoveToWorktreeTarget = { id: wt.id, label }
      if (sourceRepoId && (wt.repoId === sourceRepoId || repoKey === sourceRepoId)) {
        sameRepo.push(entry)
      } else {
        otherRepos.push(entry)
      }
    }
  }
  return [...sameRepo, ...otherRepos]
}

export function moveTabToTargetWorktree(unifiedTabId: string, targetWorktreeId: string): boolean {
  const state = useAppStore.getState()
  if (typeof state.moveTabToWorktree !== 'function') {
    return false
  }
  return state.moveTabToWorktree(unifiedTabId, targetWorktreeId)
}
