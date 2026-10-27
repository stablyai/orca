import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { JSONContent } from '@tiptap/react'
import type {
  NativeChatComposerDraftImage,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
// Expose text/document views of the durable whole-draft store so TUI switches and reloads retain unsent input.

import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { appendPromptDocumentText } from './native-chat-prompt-document-text'
import { clearNativeChatPendingAttachmentsForTests } from './native-chat-pending-attachment-cache'

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

// Why: a composer mid-IME-composition keeps showing what it had, so it is told what was appended.
const appendListeners = new Map<string, Set<(text: string, previous: string) => void>>()

/** Append returned text and notify mounted composers; true means durable hand-back so its source copy may go. */
export function appendNativeChatDraftCache(
  scopeKey: string,
  text: string,
  owner?: NativeChatComposerDraftOwner,
  /** A returned message's images, saved in the same step as the text whose chips name them. */
  images?: readonly NativeChatComposerDraftImage[]
): boolean {
  if (text === '' && !images?.length) {
    return true
  }
  const previous = readNativeChatDraftCache(scopeKey)
  const durable = appendToNativeChatComposerDraft(scopeKey, { text, images }, owner)
  // Why: an addition the draft already held adds nothing, so a composer must not show it again.
  if (readNativeChatDraftCache(scopeKey) !== previous) {
    appendListeners.get(scopeKey)?.forEach((listener) => listener(text, previous))
  }
  return durable
}

/** Append a user-initiated block verbatim: always lands, even over a duplicate or a lone /clear.
 *  No journal, so crash replay of returned text cannot duplicate it. */
export function appendNativeChatDraftCacheManual(scopeKey: string, text: string): void {
  if (text === '') {
    return
  }
  // Keep a structured draft's picked nodes (a selected skill, image chips) instead of dropping
  // them: only the text grows, so the document can grow with it.
  const current = readNativeChatComposerDraft(scopeKey)
  const previous = current.text
  const appended = previous === '' ? text : `${previous}\n\n${text}`
  updateNativeChatComposerDraft(
    scopeKey,
    { text: appended, document: appendPromptDocumentText(current.document, previous, appended) },
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
  document: JSONContent,
  pastedTextFiles?: Readonly<Record<string, string>>
): void {
  if (!text) {
    writeNativeChatDraftCache(scopeKey, '')
    return
  }
  updateNativeChatComposerDraft(scopeKey, { text, document, pastedTextFiles }, 'deferred')
}

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return readNativeChatComposerDraft(scopeKey).images.map((image) => ({ ...image }))
}

/** Persist returned images immediately; only explicit user reattachment replaces same-named unavailable placeholders. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  if (appended.length === 0) {
    return
  }
  // Preview URLs can retain the full clipboard Blob, so only the path is kept.
  appendToNativeChatComposerDraft(scopeKey, {
    images: appended.map(({ id, path, connectionId }) => ({
      id,
      path,
      ...(connectionId ? { connectionId } : {})
    })),
    ...(options?.fromUser ? { fromUser: true } : {})
  })
}

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
}
