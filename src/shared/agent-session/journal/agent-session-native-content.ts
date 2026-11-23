import type { AgentJournalItemBody } from './agent-session-journal-types'

export function isNativeConversationMessage(body: AgentJournalItemBody): boolean {
  return body.kind === 'message' && (body.role === 'user' || body.role === 'assistant')
}
