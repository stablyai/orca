// Pending operations belong to draft scopes and outlive their composers. They are not persisted;
// a finished image is, at once, in the draft.
// Completion, failure, explicit removal, draft/workspace deletion or renderer exit ends ownership.

import { useCallback, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import {
  appendNativeChatAttachmentCache,
  appendNativeChatDraftCache
} from './native-chat-draft-cache'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import {
  appendToNativeChatComposerDraft,
  nativeChatDraftScopeTabId,
  readNativeChatComposerDraft,
  resolveNativeChatComposerDraftOwner,
  structuredAgentSessionIdOfDraftScope
} from './native-chat-composer-draft-store'

const EMPTY: readonly NativeChatComposerImageAttachment[] = Object.freeze([])
const pendingCache = new Map<string, readonly NativeChatComposerImageAttachment[]>()
// Why: a chip can outlive its tab, which is what names the draft's owner, so it is named at once.
const pendingOwners = new Map<string, NativeChatComposerDraftOwner>()
const listeners = new Map<string, Set<() => void>>()

/** The scope's pending chips; the same array until they change, so a reader can subscribe to it. */
export function nativeChatPendingAttachmentSnapshot(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  return pendingCache.get(scopeKey) ?? EMPTY
}

/** Pending chips are user content before their file paths settle into the draft. */
export function nativeChatComposerHasUserContent(scopeKey: string): boolean {
  const draft = readNativeChatComposerDraft(scopeKey)
  return (
    draft.text.trim() !== '' ||
    draft.images.length > 0 ||
    nativeChatPendingAttachmentSnapshot(scopeKey).length > 0
  )
}

function writePending(scopeKey: string, next: readonly NativeChatComposerImageAttachment[]): void {
  if (next.length === 0) {
    pendingCache.delete(scopeKey)
    pendingOwners.delete(scopeKey)
  } else {
    pendingCache.set(scopeKey, next)
  }
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

export function subscribeToNativeChatPendingAttachments(
  scopeKey: string,
  listener: () => void
): () => void {
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0 && listeners.get(scopeKey) === scoped) {
      listeners.delete(scopeKey)
    }
  }
}

/** The scope's pending chips, re-rendering when they change. */
export function useNativeChatPendingAttachments(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatPendingAttachments(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPendingAttachmentSnapshot(scopeKey))
}

/** Adds a chip still on its way. Preview URLs stay with the composer that minted them. */
export function addNativeChatPendingAttachment(
  scopeKey: string,
  chip: NativeChatComposerImageAttachment
): void {
  const { previewUrl: _previewUrl, ...pending } = chip
  const owner = resolveNativeChatComposerDraftOwner(scopeKey) ?? pendingOwners.get(scopeKey)
  if (owner) {
    pendingOwners.set(scopeKey, owner)
  }
  writePending(scopeKey, [...nativeChatPendingAttachmentSnapshot(scopeKey), pending])
}

/** Removes a chip still on its way and returns it; undefined when the user already removed it. */
export function takeNativeChatPendingAttachment(
  scopeKey: string,
  id: string
): NativeChatComposerImageAttachment | undefined {
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  const taken = current.find((attachment) => attachment.id === id && attachment.pending)
  if (taken) {
    writePending(scopeKey, trimSettled(current.filter((attachment) => attachment !== taken)))
  }
  return taken
}

/** A finished image stays in the queue only to keep its place behind a chip attached before it. */
function trimSettled(
  queue: readonly NativeChatComposerImageAttachment[]
): readonly NativeChatComposerImageAttachment[] {
  const waiting = queue.findIndex((chip) => chip.pending)
  return waiting === -1 ? [] : queue.slice(waiting)
}

/** The first image attached after `queue[index]` that the draft holds. */
function heldAfter(
  scopeKey: string,
  queue: readonly NativeChatComposerImageAttachment[],
  index: number
): string | undefined {
  const held = new Set(readNativeChatComposerDraft(scopeKey).images.map(({ id }) => id))
  return queue.slice(index + 1).find(({ id }) => held.has(id))?.id
}

/** The thumbnail row: the draft's images, each chip still on its way in front of the first image
 *  attached after it, so thumbnails and chip numbers don't jump as uploads end. */
export function nativeChatImageRow<T extends { id: string }>(
  images: readonly T[],
  queue: readonly NativeChatComposerImageAttachment[]
): (T | NativeChatComposerImageAttachment)[] {
  const held = new Set(images.map(({ id }) => id))
  const ahead = new Map<string, NativeChatComposerImageAttachment[]>()
  let waiting: NativeChatComposerImageAttachment[] = []
  for (const chip of queue) {
    if (held.has(chip.id)) {
      ahead.set(chip.id, waiting)
      waiting = []
    } else if (chip.pending) {
      waiting.push(chip)
    }
  }
  return [...images.flatMap((image) => [...(ahead.get(image.id) ?? []), image]), ...waiting]
}

/** Saves a finished chip into the scope's draft at once, as an image the user attached, in front of
 *  any image attached after it. False when the user already removed it. */
export function settleNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  const index = current.findIndex((chip) => chip.id === id && chip.pending)
  if (index === -1) {
    return false
  }
  const image = { id, path, ...(connectionId ? { connectionId } : {}) }
  const before = heldAfter(scopeKey, current, index)
  appendToNativeChatComposerDraft(
    scopeKey,
    { images: [image], fromUser: true, ...(before ? { before } : {}) },
    pendingOwners.get(scopeKey)
  )
  writePending(scopeKey, trimSettled(current.map((chip) => (chip.id === id ? image : chip))))
  return true
}

/** Attaches images at once, and behind any chip still on its way, so they keep the order they were
 *  attached in: pasted or dropped alike. */
export function appendNativeChatAttachmentsAfterPending(
  scopeKey: string,
  images: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  if (images.length === 0) {
    return
  }
  appendNativeChatAttachmentCache(scopeKey, images, options)
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  if (current.length > 0) {
    writePending(scopeKey, [...current, ...images])
  }
}

/** File results settle only while their operation still belongs to this draft. */
export function settleNativeChatPendingAttachmentReferences(
  scopeKey: string,
  references: { id: string; path: string }[],
  insertAtCaret?: (paths: string[]) => void
): boolean {
  const owner = pendingOwners.get(scopeKey)
  const paths = references.flatMap(({ id, path }) =>
    takeNativeChatPendingAttachment(scopeKey, id) ? [path] : []
  )
  if (paths.length === 0) {
    return false
  }
  if (insertAtCaret) {
    insertAtCaret(paths)
  } else {
    appendNativeChatDraftCache(scopeKey, paths.map(formatNativeChatFileReference).join(' '), owner)
  }
  return true
}

export function clearNativeChatPendingAttachments(scopeKey: string): void {
  if (pendingCache.has(scopeKey)) {
    writePending(scopeKey, [])
  }
}

function dropPendingWhere(
  matches: (scopeKey: string, owner: NativeChatComposerDraftOwner | undefined) => boolean
): void {
  for (const scopeKey of pendingCache.keys()) {
    if (matches(scopeKey, pendingOwners.get(scopeKey))) {
      writePending(scopeKey, [])
    }
  }
}

/** The chips of every pane in a closed tab, matched as its drafts are; never a conversation's. */
export function dropNativeChatPendingAttachmentsForTab(tabId: string): void {
  dropPendingWhere(
    (scopeKey) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

/** The chips begun in a removed workspace, open and closed chats alike. */
export function dropNativeChatPendingAttachmentsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  dropPendingWhere(
    (_scopeKey, pendingOwner) =>
      pendingOwner?.workspaceId === owner.workspaceId &&
      pendingOwner.executionHostId === owner.executionHostId
  )
}

export function clearNativeChatPendingAttachmentsForTests(): void {
  pendingCache.clear()
  pendingOwners.clear()
}
