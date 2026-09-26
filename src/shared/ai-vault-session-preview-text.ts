import type { AiVaultSession, AiVaultSessionPreviewMessage } from './ai-vault-types'

const CONVERSATION_ROLES = new Set<AiVaultSessionPreviewMessage['role']>(['user', 'assistant'])

export function displayableSessionPreviewMessages(
  session: AiVaultSession
): AiVaultSessionPreviewMessage[] {
  const conversationTurns = session.previewMessages.filter((message) =>
    CONVERSATION_ROLES.has(message.role)
  )

  // Why: search hits should be explainable by the preview UI; tool/system text is
  // only searchable when it is the fallback preview shown for the session.
  return conversationTurns.length > 0 ? conversationTurns : session.previewMessages
}

export function sessionPreviewSearchText(session: AiVaultSession): string {
  return displayableSessionPreviewMessages(session)
    .map((message) => message.text)
    .join(' ')
}
