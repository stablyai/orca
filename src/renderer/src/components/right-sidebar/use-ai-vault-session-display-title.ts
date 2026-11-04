import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { structuredChatDisplayName } from '../../../../shared/structured-chat-row-name'
import { useAppStore } from '@/store'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredConversationName } from '@/runtime/structured-conversation-name'

/** Native rows use live saved names, falling back to authoritative host titles across closed tabs and restarts. */
export function useAiVaultSessionDisplayTitle(session: AiVaultSession): string {
  const owner = session.structuredSession
  const customLabel = useAppStore((state) => {
    const tab = owner
      ? structuredChatTabBySessionId(
          state.unifiedTabsByWorktree,
          owner.workspaceId,
          owner.sessionId
        )
      : undefined
    return tab?.agentSessionAgent === session.agent &&
      (tab.executionHostId ?? 'local') === session.executionHostId
      ? tab.customLabel
      : undefined
  })
  const conversationName = useStructuredConversationName(session.executionHostId, owner?.sessionId)
  return owner
    ? structuredChatDisplayName(customLabel, conversationName, session.title)
    : session.title
}
