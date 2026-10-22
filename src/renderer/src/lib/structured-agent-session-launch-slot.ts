import type { TabsSlice } from '@/store/slices/tabs/tabs-slice-contract'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

export type StructuredLaunchSlotOwner = Pick<
  TabsSlice,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'reorderUnifiedTabs'
>

export function removeStructuredLaunchSlot(
  owner: StructuredLaunchSlotOwner,
  worktreeId: string,
  sessionId: string
): void {
  const tabId = structuredAgentSessionTabId(sessionId)
  if (owner.unifiedTabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
    return
  }
  const groups = owner.groupsByWorktree[worktreeId] ?? []
  for (const group of groups.filter((entry) => entry.tabOrder.includes(tabId))) {
    const order = group.tabOrder.filter((id) => id !== tabId)
    owner.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
  }
}
