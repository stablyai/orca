import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import {
  structuredAgentSessionOwnerForTab,
  resolveStructuredAgentSessionOwner,
  executionHostIdForStructuredTarget
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { AgentMessageSender } from '../../../../shared/agent-session-message-source'
import type { Tab } from '../../../../shared/tab-types'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

function findChatTab(
  state: AppState,
  sessionId: string,
  executionHostId: string | null
): Tab | undefined {
  const tabsByWorktree = state.unifiedTabsByWorktree
  for (const worktreeId in tabsByWorktree) {
    const tab = structuredChatTabBySessionId(tabsByWorktree, worktreeId, sessionId)
    if (tab && structuredAgentSessionOwnerForTab(state, tab) === executionHostId) {
      return tab
    }
    // A workspace bucket can mirror identical session ids from two hosts.
    const qualified =
      tab &&
      tabsByWorktree[worktreeId]?.find(
        (candidate) =>
          candidate.contentType === 'agent-session' &&
          candidate.entityId === sessionId &&
          structuredAgentSessionOwnerForTab(state, candidate) === executionHostId
      )
    if (qualified) {
      return qualified
    }
  }
  return undefined
}

/** Live chat names follow the sender's chat on the receiving chat's host; CLI names stay as recorded. */
export function useAgentMessageSenderLabel(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget
): string {
  const { address, orcaSessionId } = sender.party
  const local = !address.startsWith('dispatch:')
  const owner = useAppStore((state) =>
    target
      ? executionHostIdForStructuredTarget(target)
      : chatWorktreeId && getKnownExecutionHostIdForWorktree(state, chatWorktreeId)
        ? resolveStructuredAgentSessionOwner(state, chatWorktreeId)
        : null
  )
  const chatTab = useAppStore((state) =>
    local && orcaSessionId ? findChatTab(state, orcaSessionId, owner) : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const ownName = chatTab ? chatTab.customLabel?.trim() || conversationName : null
  return ownName || sender.name || chatTab?.label.trim() || unnamedSenderLabel()
}
