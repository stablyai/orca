import { useCallback, useSyncExternalStore } from 'react'

/** Text a selection puts in an auxiliary chat's composer, frozen when the action ran. */
export type NativeChatAuxiliaryReference = {
  sourceSessionId: string
  sourceRowId: string
  text: string
}

export type NativeChatAuxiliaryReferenceAddResult = 'added' | 'duplicate' | 'limit'

/** The CLI's selection contract: at most 8 references, 8,000 characters each, 16,000 in total. */
export const MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_COUNT = 8
export const MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_TEXT = 8_000
export const MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_TOTAL_TEXT = 16_000

const EMPTY_REFERENCES: readonly NativeChatAuxiliaryReference[] = Object.freeze([])
// References are unsent composer context, like a draft: memory per scope, never persisted.
const referencesByScope = new Map<string, readonly NativeChatAuxiliaryReference[]>()
const listenersByScope = new Map<string, Set<() => void>>()

/** The send payload and the duplicate key keep the source fields; only `text` goes to the model. */
export function nativeChatAuxiliaryReferenceKey(reference: NativeChatAuxiliaryReference): string {
  return JSON.stringify([reference.sourceSessionId, reference.sourceRowId, reference.text])
}

export function nativeChatAuxiliaryReferenceSnapshot(
  scopeKey: string
): readonly NativeChatAuxiliaryReference[] {
  return referencesByScope.get(scopeKey) ?? EMPTY_REFERENCES
}

export function subscribeToNativeChatAuxiliaryReferences(
  scopeKey: string,
  listener: () => void
): () => void {
  const scoped = listenersByScope.get(scopeKey) ?? new Set<() => void>()
  listenersByScope.set(scopeKey, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0) {
      listenersByScope.delete(scopeKey)
    }
  }
}

export function useNativeChatAuxiliaryReferences(
  scopeKey: string
): readonly NativeChatAuxiliaryReference[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatAuxiliaryReferences(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => nativeChatAuxiliaryReferenceSnapshot(scopeKey))
}

function writeReferences(
  scopeKey: string,
  references: readonly NativeChatAuxiliaryReference[]
): void {
  if (references.length === 0) {
    referencesByScope.delete(scopeKey)
  } else {
    referencesByScope.set(scopeKey, references)
  }
  listenersByScope.get(scopeKey)?.forEach((listener) => listener())
}

/** Atomic: an over-limit reference leaves both the scope and the composer draft untouched. */
export function addNativeChatAuxiliaryReference(
  scopeKey: string,
  reference: NativeChatAuxiliaryReference
): NativeChatAuxiliaryReferenceAddResult {
  const current = nativeChatAuxiliaryReferenceSnapshot(scopeKey)
  if (reference.text.length > MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_TEXT) {
    return 'limit'
  }
  const key = nativeChatAuxiliaryReferenceKey(reference)
  if (current.some((item) => nativeChatAuxiliaryReferenceKey(item) === key)) {
    return 'duplicate'
  }
  if (current.length >= MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_COUNT) {
    return 'limit'
  }
  const total = current.reduce((sum, item) => sum + item.text.length, 0)
  if (total + reference.text.length > MAX_NATIVE_CHAT_AUXILIARY_REFERENCE_TOTAL_TEXT) {
    return 'limit'
  }
  writeReferences(scopeKey, [
    ...current,
    {
      sourceSessionId: reference.sourceSessionId,
      sourceRowId: reference.sourceRowId,
      text: reference.text
    }
  ])
  return 'added'
}

export function removeNativeChatAuxiliaryReference(
  scopeKey: string,
  reference: NativeChatAuxiliaryReference
): boolean {
  const current = nativeChatAuxiliaryReferenceSnapshot(scopeKey)
  const key = nativeChatAuxiliaryReferenceKey(reference)
  const next = current.filter((item) => nativeChatAuxiliaryReferenceKey(item) !== key)
  if (next.length === current.length) {
    return false
  }
  writeReferences(scopeKey, next)
  return true
}

export function clearNativeChatAuxiliaryReferences(scopeKey: string): void {
  if (nativeChatAuxiliaryReferenceSnapshot(scopeKey).length === 0) {
    return
  }
  writeReferences(scopeKey, EMPTY_REFERENCES)
}

/** References at a send's start; clearing only these keeps any added while it was in flight. */
export function captureNativeChatAuxiliaryReferenceSubmission(scopeKey: string): {
  readonly references: readonly NativeChatAuxiliaryReference[]
  consume: () => void
} | null {
  const references = nativeChatAuxiliaryReferenceSnapshot(scopeKey)
  if (references.length === 0) {
    return null
  }
  return {
    references,
    consume: () => {
      const current = nativeChatAuxiliaryReferenceSnapshot(scopeKey)
      const admitted = new Set(references)
      const next = current.filter((reference) => !admitted.has(reference))
      if (next.length !== current.length) {
        writeReferences(scopeKey, next)
      }
    }
  }
}

/** A sent message carries only the selected words, in the CLI's fenced structure block. */
export function withNativeChatAuxiliaryReferences(
  text: string,
  references: readonly NativeChatAuxiliaryReference[]
): string {
  if (references.length === 0) {
    return text
  }
  const block = [
    '# userselect:',
    '```userselect',
    JSON.stringify(references.map(({ text: selected }) => ({ text: selected }))),
    '```'
  ].join('\n')
  return text ? `${text}\n\n${block}` : block
}
