import {
  currentDraftScope,
  captureLaunchDraftDestination,
  retainLaunchDraftSource
} from './native-chat-launch-draft-source'
import { insertNativeChatComposerDraftText } from './native-chat-composer-draft-insertion'
// Pending chips outlive composers in memory; completed images persist immediately in their draft.

import { useCallback, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import { appendNativeChatAttachmentCache } from './native-chat-draft-cache'
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
// Capture ownership before tab removal can erase it.
const chipScopes = new Map<string, string>()
const pendingOwners = new Map<string, NativeChatComposerDraftOwner>()
const listeners = new Map<string, Set<() => void>>()

/** Keep snapshot identity stable until pending chips change. */
export function nativeChatPendingAttachmentSnapshot(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  return pendingCache.get(currentDraftScope(scopeKey)) ?? EMPTY
}

export function nativeChatComposerHasUserContent(scopeKey: string): boolean {
  const draft = readNativeChatComposerDraft(scopeKey)
  return (
    draft.text.trim() !== '' ||
    draft.images.length > 0 ||
    nativeChatPendingAttachmentSnapshot(scopeKey).length > 0
  )
}

function writePending(scopeKey: string, next: readonly NativeChatComposerImageAttachment[]): void {
  for (const chip of pendingCache.get(scopeKey) ?? []) {
    if (chipScopes.get(chip.id) === scopeKey) {
      chipScopes.delete(chip.id)
    }
  }
  for (const chip of next) {
    chipScopes.set(chip.id, scopeKey)
  }
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
  const destination = captureLaunchDraftDestination(scopeKey)
  scopeKey = currentDraftScope(scopeKey)
  const member = () => listener()
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(member)
  return () => {
    const current = listeners.get(destination?.scopeKey ?? scopeKey)
    current?.delete(member)
    if (current?.size === 0) {
      listeners.delete(destination?.scopeKey ?? scopeKey)
    }
  }
}

export function useNativeChatPendingAttachments(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatPendingAttachments(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPendingAttachmentSnapshot(scopeKey))
}

/** Keep preview URLs with the composer that minted them. */
export function addNativeChatPendingAttachment(
  scopeKey: string,
  chip: NativeChatComposerImageAttachment
): void {
  // A pending chip is the setup's first input as much as typed text, so it moves with the setup.
  retainLaunchDraftSource(scopeKey)
  scopeKey = currentDraftScope(scopeKey)
  const { previewUrl: _previewUrl, ...pending } = chip
  const owner = resolveNativeChatComposerDraftOwner(scopeKey) ?? pendingOwners.get(scopeKey)
  if (owner) {
    pendingOwners.set(scopeKey, owner)
  }
  writePending(scopeKey, [...nativeChatPendingAttachmentSnapshot(scopeKey), pending])
}

export function takeNativeChatPendingAttachment(
  scopeKey: string,
  id: string
): NativeChatComposerImageAttachment | undefined {
  scopeKey = pendingDestination(scopeKey, id)
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

function heldAfter(
  scopeKey: string,
  queue: readonly NativeChatComposerImageAttachment[],
  index: number
): string | undefined {
  const held = new Set(readNativeChatComposerDraft(scopeKey).images.map(({ id }) => id))
  return queue.slice(index + 1).find(({ id }) => held.has(id))?.id
}

/** Interleave pending chips by attachment order so completion cannot reorder thumbnails or numbers. */
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

/** Move outstanding operations with their draft; completion resolves by chip identity after the source closes. */
export function moveNativeChatPendingAttachments(from: string, to: string): void {
  const owner =
    pendingOwners.get(to) ?? resolveNativeChatComposerDraftOwner(to) ?? pendingOwners.get(from)
  if (owner) {
    pendingOwners.set(to, owner)
  }
  const pending = pendingCache.get(from) ?? EMPTY
  const held = new Set((pendingCache.get(to) ?? EMPTY).map(({ id }) => id))
  writePending(to, [
    ...(pendingCache.get(to) ?? EMPTY),
    ...pending.filter(({ id }) => !held.has(id))
  ])
  writePending(from, [])
}

/** Only continuing setup views follow association; ordinary closing editors remain keyed. */
export function moveLaunchPendingAttachmentListeners(from: string, to: string): void {
  const target = listeners.get(to) ?? new Set<() => void>()
  for (const listener of listeners.get(from) ?? []) {
    target.add(listener)
  }
  listeners.delete(from)
  listeners.set(to, target)
}

function pendingDestination(scope: string, id: string): string {
  return currentDraftScope(chipScopes.get(id) ?? scope)
}

/** Persist completed images in attachment order; return false if already removed. */
export function settleNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  scopeKey = pendingDestination(scopeKey, id)
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

/** Append behind pending chips to preserve paste/drop attachment order. */
export function appendNativeChatAttachmentsAfterPending(
  scopeKey: string,
  images: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  scopeKey = currentDraftScope(scopeKey)
  if (images.length === 0) {
    return
  }
  appendNativeChatAttachmentCache(scopeKey, images, options)
  const current = nativeChatPendingAttachmentSnapshot(scopeKey)
  if (current.length > 0) {
    writePending(scopeKey, [...current, ...images])
  }
}

export function settleNativeChatPendingAttachmentReferences(
  scopeKey: string,
  references: { id: string; path: string }[],
  insertAtCaret?: (paths: string[]) => void
): boolean {
  const originalScope = currentDraftScope(scopeKey)
  scopeKey = references.length ? pendingDestination(scopeKey, references[0].id) : scopeKey
  const owner = pendingOwners.get(scopeKey)
  const paths = references.flatMap(({ id, path }) =>
    takeNativeChatPendingAttachment(scopeKey, id) ? [path] : []
  )
  if (paths.length === 0) {
    return false
  }
  if (insertAtCaret && scopeKey === originalScope) {
    insertAtCaret(paths)
  } else {
    insertNativeChatComposerDraftText(
      scopeKey,
      paths.map(formatNativeChatFileReference).join(' '),
      { owner }
    )
  }
  return true
}

export function clearNativeChatPendingAttachments(scopeKey: string): void {
  scopeKey = currentDraftScope(scopeKey)
  if (pendingCache.has(scopeKey)) {
    writePending(scopeKey, [])
  }
}

export function dropNativeChatPendingAttachmentsWhere(
  matches: (scopeKey: string, owner: NativeChatComposerDraftOwner | undefined) => boolean
): void {
  for (const scopeKey of new Set([...pendingCache.keys(), ...listeners.keys()])) {
    if (matches(scopeKey, pendingOwners.get(scopeKey))) {
      writePending(scopeKey, [])
    }
  }
}

/** Drop only closed-tab pane chips; conversation scopes survive tab closure. */
export function dropNativeChatPendingAttachmentsForTab(tabId: string): void {
  dropNativeChatPendingAttachmentsWhere(
    (scopeKey) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

export function dropNativeChatPendingAttachmentsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  dropNativeChatPendingAttachmentsWhere((scopeKey, pendingOwner) => {
    const current = pendingOwner
    return (
      current?.workspaceId === owner.workspaceId &&
      current.executionHostId === owner.executionHostId
    )
  })
}

export function clearNativeChatPendingAttachmentsForTests(): void {
  chipScopes.clear()
  pendingCache.clear()
  pendingOwners.clear()
}
