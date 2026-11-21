import type { TabsSlice } from '@/store/slices/tabs/tabs-slice-contract'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { getStructuredLaunchStateBySessionId } from './structured-agent-session-launch-state-store'
import { readStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'

export type StructuredLaunchSlotOwner = Pick<
  TabsSlice,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'reorderUnifiedTabs'
>

/** The id a launch's chat tab takes: the one its create carries, else the legacy one. */
export function structuredLaunchSlotTabId(sessionId: string, tabId?: string): string {
  return (
    tabId ??
    getStructuredLaunchStateBySessionId(sessionId)?.intent.params.tabId ??
    readStructuredAgentLaunchRecord(sessionId)?.tabId ??
    structuredAgentSessionTabId(sessionId)
  )
}

export function removeStructuredLaunchSlot(
  owner: StructuredLaunchSlotOwner,
  worktreeId: string,
  sessionId: string,
  slotTabId?: string
): void {
  const tabId = structuredLaunchSlotTabId(sessionId, slotTabId)
  if (owner.unifiedTabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
    return
  }
  const groups = owner.groupsByWorktree[worktreeId] ?? []
  for (const group of groups.filter((entry) => entry.tabOrder.includes(tabId))) {
    const order = group.tabOrder.filter((id) => id !== tabId)
    owner.reorderUnifiedTabs(group.id, order, { recordInteraction: false })
  }
}
