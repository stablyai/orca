import { useMemo } from 'react'
import type { TabGroup } from '../../../../shared/tab-types'
import { useThreadMembership } from '../native-chat/structured-session-summary-store'
import { visibleGroupActiveTabId } from './desktop-tab-projection'

export function useDesktopVisibleGroups(
  worktreeId: string,
  groups: readonly TabGroup[],
  enabled: boolean
): readonly TabGroup[] {
  const hidden = useThreadMembership(worktreeId, enabled)
  return useMemo(
    () =>
      !hidden.size
        ? groups
        : groups.map((group) => {
            const activeTabId = visibleGroupActiveTabId(group, hidden)
            return activeTabId === group.activeTabId ? group : { ...group, activeTabId }
          }),
    [groups, hidden]
  )
}
