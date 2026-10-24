import type { NativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { JSONContent } from '@tiptap/react'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
// The composer's in-progress draft text and its editor document, keyed by the same stable pane
// scope as image attachments. The composer unmounts when the pane toggles back to the hosted
// terminal, so without this the typed-but-unsent draft would be lost on every TUI/GUI round-trip.
// A view of native-chat-composer-draft-store, which owns the whole draft and keeps it across a
// reload or quit.

import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
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
type AppendListener = (
  addition: NativeChatComposerDraftAddition,
  previous: NativeChatComposerDraft
) => void
const appendListeners = new Map<string, Set<AppendListener>>()
export type NativeChatDraftCommit = (
  change: Pick<NativeChatComposerDraft, 'text' | 'document' | 'pastedTextFiles'>
) => void

/** Puts text back after whatever is typed, and tells a mounted composer to show it. True once it
 *  is durable, so the copy it came from may go. */
export function appendNativeChatDraftCache(
  scopeKey: string,
  text: string,
  owner?: NativeChatComposerDraftOwner,
  /** A returned message's images, saved in the same step as the text whose chips name them. */
  images?: readonly NativeChatComposerDraftImage[],
  options?: Pick<NativeChatComposerDraftAddition, 'document' | 'textPolicy'> & {
    acknowledge?: (saved: Promise<boolean>) => void
  }
): boolean {
  if (text === '' && !images?.length) {
    return true
  }
  // Durable now: the copy it came from (a send handed back, a queued card) goes right after this.
  const { acknowledge, ...addition } = options ?? {}
  return appendToNativeChatComposerDraft(
    scopeKey,
    { text, images, ...addition },
    owner,
    acknowledge,
    (effective, previous) =>
      appendListeners.get(scopeKey)?.forEach((listener) => listener(effective, previous))
  )
}

export function subscribeToNativeChatDraftAppend(
  scopeKey: string,
  listener: AppendListener
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

/** Adds settled images after the ones the draft holds now, durably at once: when Stop gives images
 *  back, the copy they came from goes right after this. Only an image the user attaches
 *  (`fromUser`) takes the place of a placeholder with its file name, as a re-pick does. */
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
    images: appended.map(({ id, path, connectionId, reference }) => ({
      id,
      path,
      ...(reference ? { reference } : {}),
      ...(connectionId ? { connectionId } : {})
    })),
    ...(options?.fromUser ? { fromUser: true } : {})
  })
}

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
}
