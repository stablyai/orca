import type { JSONContent } from '@tiptap/react'
// The composer's in-progress draft text and its editor document, keyed by the same stable pane
// scope as image attachments. The composer unmounts when the pane toggles back to the hosted
// terminal, so without this the typed-but-unsent draft would be lost on every TUI/GUI round-trip.
// A view of native-chat-composer-draft-store, which owns the whole draft and keeps it across a
// reload or quit.

import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

export function readNativeChatDraftCache(scopeKey: string): string {
  return readNativeChatComposerDraft(scopeKey).text
}

/** `unsaved` shows text this run without saving it while the draft is still exactly that text. */
export function writeNativeChatDraftCache(
  scopeKey: string,
  draft: string,
  options?: { unsaved?: boolean }
): void {
  if (readNativeChatComposerDraft(scopeKey).text === draft) {
    return
  }
  // Cleared at once, so a sent or emptied draft never resurfaces.
  updateNativeChatComposerDraft(
    scopeKey,
    { text: draft, document: undefined, ...(options?.unsaved ? { unsavedText: draft } : {}) },
    draft === '' ? 'immediate' : 'deferred'
  )
}

export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// Why: a composer mid-IME-composition keeps showing what it had, so it is told what was appended.
const appendListeners = new Map<string, Set<(text: string, previous: string) => void>>()

/** Puts text back after whatever is typed, and tells a mounted composer to show it. */
export function appendNativeChatDraftCache(scopeKey: string, text: string): void {
  if (text === '') {
    return
  }
  const previous = readNativeChatDraftCache(scopeKey)
  // Saved now: the copy it came from (an outbox entry, a queued card) goes right after this.
  updateNativeChatComposerDraft(
    scopeKey,
    { text: appendNativeChatDraftText(previous, text), document: undefined },
    'immediate'
  )
  appendListeners.get(scopeKey)?.forEach((listener) => listener(text, previous))
}

export function subscribeToNativeChatDraftAppend(
  scopeKey: string,
  listener: (text: string, previous: string) => void
): () => void {
  const listeners = appendListeners.get(scopeKey) ?? new Set()
  appendListeners.set(scopeKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && appendListeners.get(scopeKey) === listeners) {
      appendListeners.delete(scopeKey)
    }
  }
}

export function clearNativeChatDraftCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
}

export function readNativeChatDraftDocument(
  scopeKey: string,
  text: string
): JSONContent | undefined {
  const draft = readNativeChatComposerDraft(scopeKey)
  return draft.text === text ? draft.document : undefined
}

export function writeNativeChatDraftDocument(
  scopeKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    writeNativeChatDraftCache(scopeKey, '')
    return
  }
  updateNativeChatComposerDraft(scopeKey, { text, document }, 'deferred')
}
