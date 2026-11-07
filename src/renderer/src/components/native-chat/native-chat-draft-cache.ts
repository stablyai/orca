import type { Tab } from '../../../../shared/tab-types'
import { retireNativeChatDraftPosition } from './native-chat-composer-draft-memory'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { JSONContent } from '@tiptap/react'
import type {
  NativeChatComposerDraftImage,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
// Expose text/document views of the durable whole-draft store so TUI switches and reloads retain unsent input.

import { sameNativeChatComposerDraftImages } from './native-chat-composer-draft-comparison'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { clearNativeChatPendingAttachmentsForTests } from './native-chat-pending-attachment-cache'
import { currentDraftScope } from './native-chat-launch-draft-source'
import {
  replaceNativeChatDraftInput,
  type NativeChatDraftConsumption
} from './native-chat-composer-draft-input'

export function readNativeChatDraftCache(scopeKey: string): string {
  return readNativeChatComposerDraft(scopeKey).text
}

export type NativeChatDraftWriteOptions = {
  /** Shows text this run without saving it while the draft is still exactly that text. */
  readonly unsaved?: boolean
  /** An applied Send or accepted command consumed the shown input (all of it, or its text). */
  readonly consumed?: NativeChatDraftConsumption
}

export function writeNativeChatDraftCache(
  scopeKey: string,
  draft: string,
  options?: NativeChatDraftWriteOptions
): void {
  if (readNativeChatComposerDraft(scopeKey).text === draft) {
    return
  }
  if (options?.consumed) {
    replaceNativeChatDraftInput(currentDraftScope(scopeKey), options.consumed)
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

/** Clear only the sent draft’s unchanged portion so late acceptance cannot erase newer typing or attachments. */
export function clearNativeChatComposerDraftIfUnchanged(
  scopeKey: string,
  sent: NativeChatComposerDraft
): boolean {
  const current = readNativeChatComposerDraft(scopeKey)
  if (
    current.text !== sent.text ||
    !sameNativeChatComposerDraftImages(current.images, sent.images)
  ) {
    return false
  }
  // What was sent goes, including what the unread base held under it.
  replaceNativeChatDraftInput(currentDraftScope(scopeKey))
  updateNativeChatComposerDraft(scopeKey, { text: '', images: [] }, 'immediate')
  return true
}
