import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  appendToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'
import { notifyDraftAppend } from './native-chat-composer-draft-memory'
import { appendPromptDocumentText } from '../composer/editor/native-chat-prompt-document-text'
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

/** Append a user-initiated block verbatim: always lands, even over a duplicate or a lone /clear.
 *  No journal, so crash replay of returned text cannot duplicate it. */
export function appendNativeChatDraftCacheManual(scopeKey: string, text: string): void {
  if (text === '') {
    return
  }
  // Keep a structured draft's picked nodes (a selected skill, image chips) instead of dropping
  // them: only the text grows, so the document can grow with it.
  const before = readNativeChatComposerDraft(scopeKey)
  const insert = <T extends NativeChatComposerDraft>(draft: T): T => {
    const previous = draft.text
    const appended = previous === '' ? text : `${previous}\n\n${text}`
    return {
      ...draft,
      text: appended,
      document: appendPromptDocumentText(draft.document, previous, appended)
    }
  }
  updateNativeChatComposerDraft(scopeKey, insert(before), 'immediate', insert)
  notifyDraftAppend(scopeKey, insert, before)
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
