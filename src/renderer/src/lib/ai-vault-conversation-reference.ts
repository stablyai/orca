import type { AiVaultSession } from '../../../shared/ai-vault-types'
import type { ConversationReferenceCreate } from '../../../shared/conversation-reference'

export function aiVaultConversationReference(
  session: AiVaultSession,
  title = session.title
): ConversationReferenceCreate {
  return {
    source: session.structuredSession
      ? { kind: 'structured', ...session.structuredSession }
      : {
          kind: 'transcript',
          agent: session.agent,
          sessionId: session.sessionId,
          filePath: session.filePath,
          codexHome: session.codexHome
        },
    title: title.slice(0, 1024),
    executionHostId: session.executionHostId
  }
}
