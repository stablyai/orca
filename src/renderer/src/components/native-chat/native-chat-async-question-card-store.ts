// Desktop async question card state per conversation scope, kept outside React like the
// composer draft cache: the card unmounts on every terminal↔chat toggle, a send settles into
// it after an unmount, and a withdrawn structured answer is handed back to it.

import {
  EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE,
  reduceNativeChatAsyncQuestionScope,
  type NativeChatAsyncQuestionCardScope,
  type NativeChatAsyncQuestionScopeAction
} from '../../../../shared/native-chat-async-question-card-state'
import { pruneNativeChatAsyncQuestionKeys } from '../../../../shared/native-chat-async-question-answers'
import type { NativeChatAsyncQuestionsView } from '../../../../shared/native-chat-async-questions'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

export type NativeChatAsyncQuestionCardStoreScope = NativeChatAsyncQuestionCardScope & {
  /** Answers a withdrawal gave back, by question key; shown under the user's own edits. */
  returned: Readonly<Record<string, string>>
}

const EMPTY_SCOPE: NativeChatAsyncQuestionCardStoreScope = {
  ...EMPTY_NATIVE_CHAT_ASYNC_QUESTION_CARD_SCOPE,
  returned: {}
}

const scopes = new Map<string, NativeChatAsyncQuestionCardStoreScope>()
const listeners = new Map<string, Set<() => void>>()

export function readNativeChatAsyncQuestionCardScope(
  scopeKey: string
): NativeChatAsyncQuestionCardStoreScope {
  return scopes.get(scopeKey) ?? EMPTY_SCOPE
}

function isEmptyScope(scope: NativeChatAsyncQuestionCardStoreScope): boolean {
  return (
    !scope.sending &&
    Object.keys(scope.edits).length === 0 &&
    Object.keys(scope.dismissed).length === 0 &&
    Object.keys(scope.returned).length === 0
  )
}

function updateScope(
  scopeKey: string,
  update: (scope: NativeChatAsyncQuestionCardStoreScope) => NativeChatAsyncQuestionCardStoreScope
): void {
  const current = readNativeChatAsyncQuestionCardScope(scopeKey)
  const next = update(current)
  if (next === current) {
    return
  }
  if (isEmptyScope(next)) {
    scopes.delete(scopeKey)
  } else {
    setBoundedScopeCacheEntry(scopes, scopeKey, next)
  }
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

export function dispatchNativeChatAsyncQuestionCard(
  scopeKey: string,
  action: NativeChatAsyncQuestionScopeAction
): void {
  updateScope(scopeKey, (scope) => ({
    ...reduceNativeChatAsyncQuestionScope(scope, action),
    // A send carries what was given back; an edit replaces it for that question.
    returned:
      action.type === 'sending'
        ? {}
        : action.type === 'edit'
          ? Object.fromEntries(Object.entries(scope.returned).filter(([key]) => key !== action.key))
          : scope.returned
  }))
}

/** Drops state for questions an authoritative set no longer lists. */
export function pruneNativeChatAsyncQuestionCardScope(
  scopeKey: string,
  view: NativeChatAsyncQuestionsView
): void {
  updateScope(scopeKey, (scope) => {
    const edits = pruneNativeChatAsyncQuestionKeys(view, scope.edits)
    const dismissed = pruneNativeChatAsyncQuestionKeys(view, scope.dismissed)
    const returned = pruneNativeChatAsyncQuestionKeys(view, scope.returned)
    return edits === scope.edits && dismissed === scope.dismissed && returned === scope.returned
      ? scope
      : { ...scope, edits, dismissed, returned }
  })
}

/** Gives answers a withdrawal took back to their card, under whatever was given back since. */
export function restoreNativeChatAsyncQuestionAnswers(
  scopeKey: string,
  answers: Readonly<Record<string, string>>
): void {
  if (Object.keys(answers).length === 0) {
    return
  }
  updateScope(scopeKey, (scope) => ({ ...scope, returned: { ...answers, ...scope.returned } }))
}

export function subscribeNativeChatAsyncQuestionCardScope(
  scopeKey: string,
  listener: () => void
): () => void {
  const scopeListeners = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scopeListeners)
  scopeListeners.add(listener)
  return () => {
    scopeListeners.delete(listener)
    if (scopeListeners.size === 0 && listeners.get(scopeKey) === scopeListeners) {
      listeners.delete(scopeKey)
    }
  }
}

export function clearNativeChatAsyncQuestionCardStoreForTests(): void {
  scopes.clear()
}
