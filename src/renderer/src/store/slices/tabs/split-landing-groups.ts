import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import type { TabGroup } from '../../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

type SplitLandingMarks = Pick<AppState, 'groupsByWorktree' | 'splitLandingGroupIds'>
type SplitLandingState = SplitLandingMarks & Pick<AppState, 'activeGroupIdByWorktree'>

/** A chat split's chooser pane while it is still empty; other empty groups await content already chosen. */
export function isSplitLandingGroup(
  state: SplitLandingMarks,
  worktreeId: string,
  group: TabGroup | undefined
): group is TabGroup {
  return (
    group !== undefined &&
    state.splitLandingGroupIds?.[group.id] === worktreeId &&
    worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    group.tabOrder.length === 0
  )
}

/** A waiting chooser keeps its workspace open when the last tab beside it closes. */
export function hasSplitLandingGroup(state: SplitLandingMarks, worktreeId: string): boolean {
  return (state.groupsByWorktree?.[worktreeId] ?? []).some((group) =>
    isSplitLandingGroup(state, worktreeId, group)
  )
}

export function findFocusedSplitLandingGroup(
  state: SplitLandingState,
  worktreeId: string | null | undefined
): TabGroup | null {
  if (!worktreeId) {
    return null
  }
  const groupId = state.activeGroupIdByWorktree?.[worktreeId]
  const group = state.groupsByWorktree?.[worktreeId]?.find((candidate) => candidate.id === groupId)
  return isSplitLandingGroup(state, worktreeId, group) ? group : null
}

/** Drops a chooser mark once its group is gone, whichever path removed it. */
export function pruneSplitLandingGroupsOnGroupRemoval(api: StoreApi<AppState>): void {
  api.subscribe((state, previous) => {
    const marks = state.splitLandingGroupIds
    if (state.groupsByWorktree === previous.groupsByWorktree || isEmpty(marks)) {
      return
    }
    const live = Object.entries(marks).filter(([groupId, worktreeId]) =>
      state.groupsByWorktree[worktreeId]?.some((group) => group.id === groupId)
    )
    if (live.length < Object.keys(marks).length) {
      api.setState({ splitLandingGroupIds: Object.fromEntries(live) })
    }
  })
}

function isEmpty(record: Record<string, string>): boolean {
  for (const _ in record) {
    return false
  }
  return true
}
