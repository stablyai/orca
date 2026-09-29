import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ConversationHistoryTarget } from '@/lib/conversation-history-selection'

export function exactConversationHistorySessions(
  sessions: readonly AiVaultSession[],
  target: ConversationHistoryTarget | null
): AiVaultSession[] {
  if (!target) {
    return []
  }
  return sessions.filter(
    (session) =>
      session.executionHostId === target.executionHostId &&
      session.agent === target.agent &&
      session.sessionId === target.sessionId
  )
}
