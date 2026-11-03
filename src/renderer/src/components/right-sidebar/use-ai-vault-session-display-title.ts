import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { structuredChatDisplayName } from '../../../../shared/structured-chat-row-name'
import { useAppStore } from '@/store'
import { terminalTabTitleForSession } from './ai-vault-terminal-tab-title'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredConversationName } from '@/runtime/structured-conversation-name'

/** Terminal rows show their tab's custom title while the tab is open. Native rows use live saved names, falling back to authoritative host titles across closed tabs and restarts. */
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
  const terminalTabTitle = useAppStore((state) => {
    if (owner) {
      return null
    }
    return terminalTabTitleForSession(state, session)
  })
  const conversationName = useStructuredConversationName(session.executionHostId, owner?.sessionId)
  return owner
    ? structuredChatDisplayName(customLabel, conversationName, session.title)
    : (terminalTabTitle ?? session.title)
}
