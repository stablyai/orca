import {
  collectAgentTypesByWorktree,
  collidingWorktreeIds,
  worktreeMatchesAgentFilter
} from '@/components/sidebar/workspace-agent-filter-evidence'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'

type EmptyQueryAgentFilterArgs = Pick<
  WorktreeJumpPaletteStoreState,
  | 'filterAgentIds'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'runtimePaneTitlesByTabId'
  | 'terminalLayoutsByTabId'
>

// Why extracted: the palette hook is at the line cap. Agent scope uses the same
// host-qualified evidence as the sidebar, including twins the other filters hid.
export function filterEmptyQueryWorktreesByAgent(
  visible: readonly Worktree[],
  allWorktrees: readonly Worktree[],
  args: EmptyQueryAgentFilterArgs
): Worktree[] {
  if (!args.filterAgentIds) {
    return [...visible]
  }
  const selectedAgentIds = args.filterAgentIds
  const agentTypesByWorktree = collectAgentTypesByWorktree({
    agentStatusByPaneKey: args.agentStatusByPaneKey,
    retainedAgentsByPaneKey: args.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: args.sleepingAgentSessionsByPaneKey,
    tabsByWorktree: args.tabsByWorktree,
    worktrees: allWorktrees
  })
  const collidingIds = collidingWorktreeIds(allWorktrees)
  return visible.filter((worktree) =>
    worktreeMatchesAgentFilter(worktree, selectedAgentIds, {
      tabsByWorktree: args.tabsByWorktree,
      agentTypesByWorktree,
      runtimePaneTitlesByTabId: args.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      collidingWorktreeIds: collidingIds
    })
  )
}
