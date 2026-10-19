import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  historyRowShowsChatName,
  structuredChatDisplayName
} from '../../../../shared/structured-chat-row-name'
import { useAppStore } from '@/store'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredConversationName } from '@/runtime/structured-conversation-name'

/** A Claude or Codex chat's row reads the same name as the chat's tab; the host's row title is the
 *  fallback for a chat its host has not published this run, such as one closed before a restart.
 *  Other agents' rows keep their CLI's own title. */
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
