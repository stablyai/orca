// Share preview/search text with mobile, which cannot import renderer modules. Keep this shared leaf limited to shared type imports.
import type { AiVaultSession, AiVaultSessionPreviewMessage } from './ai-vault-types'

const CONVERSATION_ROLES = new Set<AiVaultSessionPreviewMessage['role']>(['user', 'assistant'])

export type AiVaultSessionDisplayTurn = {
  role: AiVaultSessionPreviewMessage['role']
  text: string
  timestamp: string | null
}

export type AiVaultSessionPromptPreview = {
  text: string
  source: 'first-user-prompt' | 'preview-window'
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

export function sessionDetailConversationTurns(
  session: AiVaultSession,
  limit: number
): AiVaultSessionDisplayTurn[] {
  if (limit <= 0) {
    return []
  }

  const turns = displayableSessionPreviewMessages(session)
    .map(toDisplayTurn)
    .filter((turn) => !turnTextMatchesSessionTitle(session.title, turn.text))

  return dedupeAdjacentConversationTurns(turns).slice(-limit)
}

/** Prompt text with enough provenance for the renderer to avoid overclaiming. */
export function sessionPromptPreview<
  T extends Pick<AiVaultSession, 'firstUserPrompt' | 'previewMessages'>
>(session: T): AiVaultSessionPromptPreview | null {
  const stored = session.firstUserPrompt?.trim()
  if (stored) {
    return { text: stored, source: 'first-user-prompt' }
  }

  for (const message of session.previewMessages) {
    if (message.role !== 'user') {
      continue
    }
    const text = message.text.trim()
    if (text) {
      return { text, source: 'preview-window' }
    }
  }

  return null
}

function turnTextMatchesSessionTitle(title: string, turnText: string): boolean {
  const sessionText = normalizeSessionDisplayText(title)
  const candidateText = normalizeSessionDisplayText(turnText)
  if (!sessionText || !candidateText) {
    return false
  }
  if (sessionText === candidateText) {
    return true
  }
  const longEnough = sessionText.length >= 24 && candidateText.length >= 24
  return (
    longEnough && (sessionText.startsWith(candidateText) || candidateText.startsWith(sessionText))
  )
}

function dedupeAdjacentConversationTurns(
  turns: AiVaultSessionDisplayTurn[]
): AiVaultSessionDisplayTurn[] {
  const deduped: AiVaultSessionDisplayTurn[] = []
  for (const turn of turns) {
    const previous = deduped.at(-1)
    if (
      previous &&
      previous.role === turn.role &&
      normalizeSessionDisplayText(previous.text) === normalizeSessionDisplayText(turn.text)
    ) {
      continue
    }
    deduped.push(turn)
  }
  return deduped
}

function normalizeSessionDisplayText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function sessionModelLabel(session: AiVaultSession): string | null {
  return session.model || null
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

  // Search tool/system text only as the displayed fallback preview so hits remain explainable.
  return conversationTurns.length > 0 ? conversationTurns : session.previewMessages
}

function toDisplayTurn(message: AiVaultSessionPreviewMessage): AiVaultSessionDisplayTurn {
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp
  }
}
