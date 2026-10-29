// Pending paste tokens track draft position through edits and never reach the agent.
import { translate } from '@/i18n/i18n'

/** Only live I/O holds source bytes; failure and renderer exit leave an unavailable token. */
export const nativeChatPastedTextOperations = new Map<string, { scopeKey: string; text: string }>()

export function nativeChatPastedTextLabel(): string {
  return translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
}

export function nativeChatPasteNotSavedNotice(): string {
  return translate(
    'components.native-chat.composer.pasteNotSaved',
    'This paste was not saved. Paste it again or remove it.'
  )
}

/** Captures each token, so text split around them has the tokens at odd indices. */
export const NATIVE_CHAT_PASTED_TEXT_TOKEN = /(\[Pasted text\]\(orca-paste:[0-9a-f-]{36}\))/

export function nativeChatPastedTextToken(id: string): string {
  return `[Pasted text](orca-paste:${id})`
}

export function nativeChatPastedTextId(token: string): string | null {
  return /^\[Pasted text\]\(orca-paste:([0-9a-f-]{36})\)$/.exec(token)?.[1] ?? null
}
