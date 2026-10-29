import { translate } from '@/i18n/i18n'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { notifyScope } from './native-chat-composer-draft-memory'
import {
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextOperations as operations,
  nativeChatPastedTextId,
  nativeChatPastedTextToken,
  nativeChatPasteNotSavedNotice
} from './native-chat-pasted-text-reference'

export function nativeChatPastedTextState(scope: string, token: string): string | null {
  const id = nativeChatPastedTextId(token)
  if (!id) {
    return null
  }
  return (
    readNativeChatComposerDraft(scope).pastedTextFiles?.[id] ??
    (operations.get(id)?.scopeKey === scope ? 'saving' : 'unsaved')
  )
}

/** Only completed paths need boundaries; copied source bytes remain literal. */
export function resolveNativeChatPastedText(scope: string, text: string, copy = false): string {
  let resolved = ''
  let pathBefore = false
  text.split(NATIVE_CHAT_PASTED_TEXT_TOKEN).forEach((part, index) => {
    const state = index % 2 === 1 ? nativeChatPastedTextState(scope, part) : null
    const path = state !== null && state !== 'saving' && state !== 'unsaved'
    const piece = path
      ? formatNativeChatFileReference(state)
      : !copy || state === null
        ? part
        : state === 'saving'
          ? (operations.get(nativeChatPastedTextId(part) ?? '')?.text ?? '')
          : translate('components.native-chat.composer.pasteNotSavedLabel', 'Paste not saved')
    if (!piece) {
      return
    }
    if ((path || pathBefore) && /\S$/.test(resolved) && /^\S/.test(piece)) {
      resolved += ' '
    }
    resolved += piece
    pathBefore = path
  })
  return resolved
}

/** Both the actual candidate and its original scope must be free of unavailable identities. */
export function nativeChatPastedTextAdmission(
  scope: string,
  candidate = ''
): 'saving' | 'unsaved' | null {
  const states = [readNativeChatComposerDraft(scope).text, candidate]
    .join('\n')
    .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
    .filter((_, index) => index % 2 === 1)
    .map((token) => nativeChatPastedTextState(scope, token))
  return states.includes('saving') ? 'saving' : states.includes('unsaved') ? 'unsaved' : null
}

export function admitNativeChatPastedText(
  scope: string,
  candidate: string,
  onError: (notice: string) => void
): boolean {
  const state = nativeChatPastedTextAdmission(scope, candidate)
  if (state === 'unsaved') {
    onError(nativeChatPasteNotSavedNotice())
  }
  return state === null
}

/** Success records one durable fact; every failure ends I/O without editing the draft. */
export function settleNativeChatPastedText(id: string, path?: string): boolean {
  const operation = operations.get(id)
  if (!operation) {
    return false
  }
  operations.delete(id)
  const { scopeKey } = operation
  const draft = readNativeChatComposerDraft(scopeKey)
  const present = draft.text.includes(nativeChatPastedTextToken(id))
  if (present && path) {
    updateNativeChatComposerDraft(
      scopeKey,
      { pastedTextFiles: { ...draft.pastedTextFiles, [id]: path } },
      'immediate'
    )
  } else {
    notifyScope(scopeKey)
  }
  return present
}
