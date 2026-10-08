import type { ChatUiRowConditions } from '@/components/settings/chat-search'
import { useLocalStructuredChatsInUse } from '@/runtime/local-structured-chats'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useStructuredAgentSessionHostQueuesMessages } from '@/runtime/structured-agent-session-host-capability'

// Settings edits this machine's settings, so it asks this machine's runtime.
const LOCAL_CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

/** The live Chat UI row conditions the Settings index is built from; see `getChatUiSearchEntries`. */
export function useChatUiRowConditions(): Omit<ChatUiRowConditions, 'isWebClient'> {
  return {
    structuredChatsInUse: useLocalStructuredChatsInUse(),
    hostQueuesChatMessages: useStructuredAgentSessionHostQueuesMessages(LOCAL_CHAT_HOST)
  }
}
