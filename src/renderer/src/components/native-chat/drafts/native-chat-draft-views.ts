import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  appendToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type {
  NativeChatComposerDraftOwner,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'
import type { JSONContent } from '@tiptap/react'

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
  return appendToNativeChatComposerDraft(scopeKey, { text, images }, owner)
}

export function readNativeChatDraftSnapshot(scopeKey: string | undefined, text: string) {
  const draft = scopeKey ? readNativeChatComposerDraft(scopeKey) : undefined
  return draft?.text === text ? draft : undefined
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
