import type { JcodeConversationRecord } from '../../../../shared/jcode-chat-types'
import type { JcodeToolCall } from './JcodeToolCard'
import type { ChatMessage, ChatSessionContext, ChatSessionState } from './chat-session-types'

/** First non-empty user message, trimmed, as a human title for "Recent chats". */
export function deriveChatSessionTitle(state: ChatSessionState): string {
  const firstUser = state.messages.find((m) => m.role === 'user' && m.text.trim())
  const text = firstUser?.text.trim() ?? 'New chat'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

function persistedMessagesFromState(state: ChatSessionState): JcodeConversationRecord['messages'] {
  return state.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    ...(m.tools ? { tools: m.tools } : {}),
    ...(m.isError ? { isError: m.isError } : {})
  }))
}

export function buildJcodeConversationRecord(
  sessionKey: string,
  state: ChatSessionState,
  context: ChatSessionContext | undefined
): JcodeConversationRecord {
  return {
    sessionKey,
    worktreeId: context?.worktreeId,
    cwd: context?.cwd,
    title: deriveChatSessionTitle(state),
    updatedAt: Date.now(),
    resumeSessionId: state.resumeSessionId,
    composerProvider: state.composerProvider,
    composerModel: state.composerModel,
    composerProviderProfile: state.composerProviderProfile,
    messages: persistedMessagesFromState(state)
  }
}

export function chatMessagesFromRecord(record: JcodeConversationRecord): ChatMessage[] {
  return record.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    tools: Array.isArray(m.tools) ? (m.tools as JcodeToolCall[]) : undefined,
    isError: m.isError
  }))
}
