import { conversationNameSeed } from './conversation-name-generation'
import {
  conversationPreferenceKey,
  type ConversationPreferences
} from './conversation-navigation-preferences'
import { AI_VAULT_AGENT_LABELS, type AiVaultSession } from './ai-vault-types'
import { sessionPromptPreview } from './ai-vault-session-display'
import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'

const GENERIC_TITLES = new Set(
  Object.values(AI_VAULT_AGENT_LABELS)
    .flatMap((label) => [`${label} Chat`, `${label} чат`])
    .map((label) => label.toLowerCase())
)

export function isGenericConversationTitle(title: string): boolean {
  const value = title.trim()
  return (
    !value ||
    /^[.\s\u2026]+$/u.test(value) ||
    GENERIC_TITLES.has(value.toLowerCase()) ||
    isKnownHarnessInjectedUserTurnText(value) ||
    Object.values(AI_VAULT_AGENT_LABELS).some(
      (label) =>
        value.startsWith(`${label} `) && /^[0-9a-f]{8}$/iu.test(value.slice(label.length + 1))
    )
  )
}

export function projectConversationTitle(
  session: Pick<AiVaultSession, 'title' | 'previewMessages' | 'firstUserPrompt'>,
  title = session.title
): string {
  if (!isGenericConversationTitle(title)) {
    return title
  }
  const prompt = sessionPromptPreview({
    firstUserPrompt:
      session.firstUserPrompt && !isKnownHarnessInjectedUserTurnText(session.firstUserPrompt)
        ? session.firstUserPrompt
        : null,
    previewMessages: session.previewMessages.filter(
      (message) => !isKnownHarnessInjectedUserTurnText(message.text)
    )
  })
  return (
    conversationNameSeed(prompt?.text ?? '') ??
    (isKnownHarnessInjectedUserTurnText(title) ? '' : title)
  )
}

export function projectConversations(
  sessions: readonly AiVaultSession[],
  preferences: ConversationPreferences,
  archived = false
): AiVaultSession[] {
  return sessions
    .filter(
      (session) =>
        session.conversationContent !== 'empty' &&
        (preferences.entries[conversationPreferenceKey(session)]?.archived === true) === archived
    )
    .sort((a, b) => {
      const pinned =
        Number(preferences.entries[conversationPreferenceKey(b)]?.pinned === true) -
        Number(preferences.entries[conversationPreferenceKey(a)]?.pinned === true)
      return (
        pinned ||
        (Date.parse(b.updatedAt ?? b.modifiedAt) || 0) -
          (Date.parse(a.updatedAt ?? a.modifiedAt) || 0)
      )
    })
}

export const PROJECT_CONVERSATION_PAGE_SIZE = 5
