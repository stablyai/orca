import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { findReusableRightSplitGroupId } from './emulator-right-split-target'

type RightSplitTargetState = {
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
  activeGroupIdByWorktree?: Record<string, string | undefined>
  groupsByWorktree?: Record<string, { id: string }[] | undefined>
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: 'right',
    opts: { activate: boolean; recordInteraction?: boolean }
  ) => string | null
}

/** The group content should land in when it must sit to the RIGHT of its source.
 *  Reuses the nearest existing right sibling so repeated opens share one pane. */
export function resolveRightSplitTargetGroupId(
  state: RightSplitTargetState,
  worktreeId: string,
  sourceGroupId: string | null,
  opts: { activate: boolean; recordInteraction?: boolean }
): string | null {
  const source =
    sourceGroupId ??
    state.activeGroupIdByWorktree?.[worktreeId] ??
    state.groupsByWorktree?.[worktreeId]?.[0]?.id ??
    null
  if (source === null) {
    return null
  }
  return (
    findReusableRightSplitGroupId(state.layoutByWorktree?.[worktreeId], source) ??
    state.createEmptySplitGroup(worktreeId, source, 'right', opts)
  )
}
