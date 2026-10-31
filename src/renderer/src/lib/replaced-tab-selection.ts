import { useAppStore } from '@/store'
import { tabActivationPatch } from '@/store/slices/tabs/tabs-focus-actions'
import type { AppState } from '@/store/types'

/** A same-slot switch takes the selection only while the tab it replaces still holds it, judged
 *  in its group when the replace lands: a user who picked another tab there keeps that choice. A
 *  tab no group lists is no proof the user stayed on it. */
export function replacedTabHoldsSelection(
  state: Pick<AppState, 'groupsByWorktree'>,
  worktreeId: string,
  tab: { id: string; groupId: string }
): boolean {
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === tab.groupId)
  return group !== undefined && (group.activeTabId == null || group.activeTabId === tab.id)
}

/** Whether the user is looking at this group now: it is the active group of their workspace. */
export function replacedTabGroupInView(
  state: Pick<AppState, 'activeWorktreeId' | 'activeGroupIdByWorktree'>,
  worktreeId: string,
  groupId: string
): boolean {
  return (
    state.activeWorktreeId === worktreeId &&
    (state.activeGroupIdByWorktree[worktreeId] ?? groupId) === groupId
  )
}

/** What a replacement takes, decided as the replace lands: focus where the user is looking at its
 *  source, only its group's selection where they aren't, or nothing once they picked another tab. */
export function replacementSelection(
  state: Pick<AppState, 'groupsByWorktree' | 'activeWorktreeId' | 'activeGroupIdByWorktree'>,
  worktreeId: string,
  replaced: { id: string; groupId: string }
): 'focus' | 'group' | 'none' {
  return !replacedTabHoldsSelection(state, worktreeId, replaced)
    ? 'none'
    : replacedTabGroupInView(state, worktreeId, replaced.groupId)
      ? 'focus'
      : 'group'
}

/** The replacement takes its group's selection where the user isn't looking: their workspace,
 *  active group and focus stay where they are. */
export function selectReplacementInGroup(worktreeId: string, tabId: string): void {
  useAppStore.setState((state) => {
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
    return tab
      ? {
          ...tabActivationPatch(state, tab, worktreeId, { recordFocus: false }, false),
          activeGroupIdByWorktree: state.activeGroupIdByWorktree
        }
      : state
  })
}
