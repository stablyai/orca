// Where a tab sits on screen, for the Tab strip order of the all-workspaces scope.

import type { Tab } from '../../../../shared/tab-types'
import { collectTabGroupLayoutGroupIds } from '../../../../shared/workspace-layout/tab-group-moves'
import type { Worktree } from '../../../../shared/worktree/types'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import type { VisibleWorktreeShortcutTarget } from '../sidebar/visible-worktrees'
import type { AllWorkspacesRecentTabState } from './all-workspaces-recent-tab-switching'

const UNPLACED = Number.MAX_SAFE_INTEGER

function hostKey(hostId: string | undefined, worktreeId: string): string {
  return `${hostId ?? ''}\u0000${worktreeId}`
}

// Why: Tab strip order reads the screen, so workspaces follow the rendered sidebar rows (as for
// Cmd+1-9) and panes follow the layout tree, not the creation order of the groups array.
export function createTabStripPositioner(
  state: Pick<AllWorkspacesRecentTabState, 'groupsByWorktree' | 'layoutByWorktree'>,
  worktrees: readonly Worktree[],
  sidebarOrder: readonly VisibleWorktreeShortcutTarget[]
): (worktree: Worktree, tab: Tab | undefined, pageIndex?: number) => number[] {
  const sidebarRank = new Map(
    sidebarOrder.map((target, index) => [hostKey(target.executionHostId, target.id), index])
  )
  const worktreeRank = new Map(
    worktrees.map((worktree, index) => [
      getPaletteWorktreeIdentity(worktree),
      sidebarRank.get(hostKey(worktree.hostId, worktree.id)) ?? sidebarOrder.length + index
    ])
  )
  const paneRankByWorktree = new Map<string, Map<string, number>>()
  const paneRank = (worktreeId: string, groupId: string): number => {
    let ranks = paneRankByWorktree.get(worktreeId)
    if (!ranks) {
      ranks = new Map<string, number>()
      for (const id of [
        ...collectTabGroupLayoutGroupIds(state.layoutByWorktree[worktreeId]),
        ...(state.groupsByWorktree[worktreeId] ?? []).map((group) => group.id)
      ]) {
        if (!ranks.has(id)) {
          ranks.set(id, ranks.size)
        }
      }
      paneRankByWorktree.set(worktreeId, ranks)
    }
    return ranks.get(groupId) ?? UNPLACED
  }
  return (worktree, tab, pageIndex = 0) => {
    const group = tab
      ? (state.groupsByWorktree[worktree.id] ?? []).find((entry) => entry.id === tab.groupId)
      : undefined
    const tabRank = tab && group ? group.tabOrder.indexOf(tab.id) : -1
    return [
      worktreeRank.get(getPaletteWorktreeIdentity(worktree)) ?? UNPLACED,
      tab ? paneRank(worktree.id, tab.groupId) : UNPLACED,
      tabRank === -1 ? UNPLACED : tabRank,
      Math.max(pageIndex, 0)
    ]
  }
}

export function compareTabStripPositions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}
