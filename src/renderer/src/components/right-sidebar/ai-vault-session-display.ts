import type {
  AiVaultSession,
  AiVaultSessionPreviewMessage
} from '../../../../shared/ai-vault-types'

const CONVERSATION_ROLES = new Set<AiVaultSessionPreviewMessage['role']>(['user', 'assistant'])

export type AiVaultSessionDisplayTurn = {
  role: AiVaultSessionPreviewMessage['role']
  text: string
  timestamp: string | null
}

export function latestSessionConversationTurn(
  session: AiVaultSession
): AiVaultSessionDisplayTurn | null {
  return recentSessionConversationTurns(session, 1)[0] ?? null
}

export function recentSessionConversationTurns(
  session: AiVaultSession,
  limit: number
): AiVaultSessionDisplayTurn[] {
  if (limit <= 0) {
    return []
  }

  return displayableSessionPreviewMessages(session).slice(-limit).map(toDisplayTurn)
}

export function sessionPreviewSearchText(session: AiVaultSession): string {
  return displayableSessionPreviewMessages(session)
    .map((message) => message.text)
    .join(' ')
}

function displayableSessionPreviewMessages(
  session: AiVaultSession
): AiVaultSessionPreviewMessage[] {
  const conversationTurns = session.previewMessages.filter((message) =>
    CONVERSATION_ROLES.has(message.role)
  )

  // Why: search hits should be explainable by the preview UI; tool/system text is
  // only searchable when it is the fallback preview shown for the session.
  return conversationTurns.length > 0 ? conversationTurns : session.previewMessages
}

function toDisplayTurn(message: AiVaultSessionPreviewMessage): AiVaultSessionDisplayTurn {
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp
  }
}
