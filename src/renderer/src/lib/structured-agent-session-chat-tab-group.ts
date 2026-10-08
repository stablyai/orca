import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'

/** The tab group a chat's tab sits in, if it has one in this workspace. */
export function structuredChatTabGroupId(
  worktreeId: string,
  sessionId: string
): string | undefined {
  const tabId = structuredAgentSessionTabId(sessionId)
  return useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
    ?.groupId
}
