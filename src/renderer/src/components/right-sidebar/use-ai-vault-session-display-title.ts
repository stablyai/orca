import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  historyRowShowsChatName,
  structuredChatDisplayName
} from '../../../../shared/structured-chat-row-name'
import { useAppStore } from '@/store'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredConversationName } from '@/runtime/structured-conversation-name'

/** Match Claude/Codex tab names, falling back to host titles for unpublished chats; other agents retain CLI titles. */
export function useAiVaultSessionDisplayTitle(session: AiVaultSession): string {
  const owner = historyRowShowsChatName(session.agent) ? session.structuredSession : undefined
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
