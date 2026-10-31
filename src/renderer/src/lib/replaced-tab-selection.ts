import type { AppState } from '@/store/types'

/** A same-slot switch takes the selection only while the tab it replaces still holds it, judged
 *  in its group when the replace lands: a user who picked another tab there keeps that choice. */
export function replacedTabHoldsSelection(
  state: Pick<AppState, 'groupsByWorktree'>,
  worktreeId: string,
  tab: { id: string; groupId: string }
): boolean {
  const active = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === tab.groupId
  )?.activeTabId
  return active == null || active === tab.id
}
