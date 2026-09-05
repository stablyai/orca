import type { TabSplitDirection } from './tabs-slice-contract'

export const TAB_GROUP_SPLIT_CREATED_EVENT = 'orca:tab-group-split-created'

export type TabGroupSplitCreatedDetail = {
  worktreeId: string
  sourceGroupId: string
  targetGroupId: string
  newGroupId: string
  direction: TabSplitDirection
  unifiedTabId: string
}

export function dispatchTabGroupSplitCreated(detail: TabGroupSplitCreatedDetail): void {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function' ||
    typeof CustomEvent === 'undefined'
  ) {
    return
  }
  window.dispatchEvent(
    new CustomEvent<TabGroupSplitCreatedDetail>(TAB_GROUP_SPLIT_CREATED_EVENT, {
      detail
    })
  )
}
