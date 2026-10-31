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
  return projectPastedText([text], (token) => nativeChatPastedTextState(scope, token), copy).join(
    ''
  )
}

/** Capture completed file facts with the submitted document, before any send body is built. */
export function projectNativeChatPastedText(
  text: string,
  files: Readonly<Record<string, string>> = {}
): string {
  return projectNativeChatPastedTextParts([text], files).join('')
}

/** Opaque inline parts start nonspace; their tail preserves the existing whitespace edge. */
export type PastedTextPart<T> = string | { opaque: T; tail: string }

export function projectNativeChatPastedTextParts<T>(
  parts: readonly PastedTextPart<T>[],
  files: Readonly<Record<string, string>> = {}
): PastedTextPart<T>[] {
  return projectPastedText(parts, (token) => files[nativeChatPastedTextId(token) ?? ''] ?? null)
}

function projectPastedText<T>(
  parts: readonly PastedTextPart<T>[],
  stateOf: (token: string) => string | null,
  copy = false
): PastedTextPart<T>[] {
  const resolved: PastedTextPart<T>[] = []
  let ordinary: string[] = []
  let projected: string[] = []
  let pathBefore = false
  let nonspaceBefore = false
  const flushProjected = () => {
    if (projected.length) {
      resolved.push(projected.join(''))
      projected = []
    }
  }
  const flushOrdinary = () => {
    ordinary
      .join('')
      .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
      .forEach((part, index) => {
        const state = index % 2 === 1 ? stateOf(part) : null
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
        if ((path || pathBefore) && nonspaceBefore && /^\S/.test(piece)) {
          projected.push(' ')
        }
        projected.push(piece)
        nonspaceBefore = /\S$/.test(piece)
        pathBefore = path
      })
    ordinary = []
  }
  for (const part of parts) {
    if (typeof part === 'string') {
      ordinary.push(part)
    } else {
      flushOrdinary()
      if (pathBefore && nonspaceBefore) {
        projected.push(' ')
      }
      flushProjected()
      resolved.push(part)
      nonspaceBefore = part.tail.length === 0
      pathBefore = false
    }
  }
  flushOrdinary()
  flushProjected()
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
