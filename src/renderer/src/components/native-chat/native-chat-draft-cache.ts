import type { Tab } from '../../../../shared/tab-types'
import {
  notifyDraftAppend,
  retireNativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { JSONContent } from '@tiptap/react'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
// Expose text/document views of the durable whole-draft store so TUI switches and reloads retain unsent input.

import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
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

export function clearNativeChatDraftCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
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

/** A destination's death retires only its unsatisfied UI position, never its ordinary content. */
export function retireRemovedNativeChatDraftPositions(
  before: readonly Tab[],
  after: readonly Tab[]
): void {
  if (before === after) {
    return
  }
  const remaining = new Map(after.map((tab) => [tab.id, tab]))
  for (const tab of before) {
    const next = remaining.get(tab.id)
    if (
      tab.contentType === 'agent-session' &&
      (next?.contentType !== tab.contentType ||
        next.entityId !== tab.entityId ||
        next.executionHostId !== tab.executionHostId)
    ) {
      retireNativeChatDraftPosition(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)),
        tab.id
      )
    }
  }
}
