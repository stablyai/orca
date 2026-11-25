import {
  currentDraftScope,
  captureLaunchDraftDestination,
  retainLaunchDraftSource
} from '../../drafts/native-chat-launch-draft-source'
import { insertNativeChatComposerDraftText } from '../../drafts/native-chat-composer-draft-insertion'
import { moveDeferredNativeChatComposerNotice } from '../../composer/controls/native-chat-deferred-composer-notice'
// Pending chips outlive composers in memory; completed images persist immediately in their draft.

import { useCallback, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './native-chat-image-attachment'
import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'
import { appendNativeChatAttachmentCache } from './native-chat-attachment-draft'
import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { resolveNativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-memory'
import {
  chipScopes,
  nativeChatPendingAttachmentScope,
  savingImageChips
} from './native-chat-pending-attachment-scopes'

const EMPTY: readonly NativeChatComposerImageAttachment[] = Object.freeze([])
const pendingCache = new Map<string, readonly NativeChatComposerImageAttachment[]>()
const pendingOwners = new Map<string, NativeChatComposerDraftOwner>()
const listeners = new Map<string, Set<() => void>>()
const waitingPasteReferences = new Map<string, { settle: () => void; cancel: () => void }>()

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
  const previous = pendingCache.get(scopeKey) ?? []
  for (const chip of previous) {
    if (chipScopes.get(chip.id) === scopeKey) {
      chipScopes.delete(chip.id)
    }
  }
  for (const chip of next) {
    chipScopes.set(chip.id, scopeKey)
  }
  // Left every draft (not moved): end what the operation owned, even if its save never returns.
  for (const chip of previous) {
    if (!chipScopes.has(chip.id)) {
      savingImageChips.delete(chip.id)
      waitingPasteReferences.get(chip.id)?.cancel()
      waitingPasteReferences.delete(chip.id)
    }
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
  scopeKey = nativeChatPendingAttachmentScope(scopeKey, id)
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
  moveDeferredNativeChatComposerNotice(from, to)
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

/** Persist completed images in attachment order; return false if already removed. */
export function settleNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  scopeKey = nativeChatPendingAttachmentScope(scopeKey, id)
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

/** Defer only clipboard-image references, using each paste's own settlement callback. */
export function deferNativeChatPasteReference(
  scopeKey: string,
  id: string,
  operation: { settle: () => void; cancel: () => void }
): boolean {
  const queue = nativeChatPendingAttachmentSnapshot(nativeChatPendingAttachmentScope(scopeKey, id))
  const index = queue.findIndex((chip) => chip.id === id && chip.pending)
  // Behind an image still saving or a reference already waiting, so a later paste cannot overtake.
  if (
    index < 1 ||
    !queue
      .slice(0, index)
      .some(
        (chip) =>
          chip.pending && (savingImageChips.has(chip.id) || waitingPasteReferences.has(chip.id))
      )
  ) {
    return false
  }
  waitingPasteReferences.set(id, operation)
  return true
}

// Set while waiting references drain: they append to the draft in queue order, never at a caret.
let draining = 0

/** Settle waiting references in paste order up to the first image still saving. */
export function flushNativeChatWaitingPasteReferences(scopeKey: string): void {
  for (const chip of nativeChatPendingAttachmentSnapshot(scopeKey)) {
    if (chip.pending && savingImageChips.has(chip.id)) {
      break
    }
    const operation = waitingPasteReferences.get(chip.id)
    if (operation) {
      waitingPasteReferences.delete(chip.id)
      drainOne(operation)
    }
  }
}

function drainOne(operation: { settle: () => void }): void {
  draining += 1
  try {
    operation.settle()
  } finally {
    draining -= 1
  }
}

export function settleNativeChatPendingAttachmentReferences(
  scopeKey: string,
  references: { id: string; path: string }[],
  insertAtCaret?: (paths: string[]) => void
): boolean {
  const originalScope = currentDraftScope(scopeKey)
  scopeKey = references.length
    ? nativeChatPendingAttachmentScope(scopeKey, references[0].id)
    : scopeKey
  const owner = pendingOwners.get(scopeKey)
  const paths = references.flatMap(({ id, path }) =>
    takeNativeChatPendingAttachment(scopeKey, id) ? [path] : []
  )
  if (paths.length === 0) {
    return false
  }
  // A drained reference may belong to a replaced composer whose editor has not adopted the draft yet:
  // appending to the draft keeps every earlier reference and the paste order.
  if (insertAtCaret && scopeKey === originalScope && draining === 0) {
    insertAtCaret(paths)
  } else {
    insertNativeChatComposerDraftText(
      scopeKey,
      paths.map(formatNativeChatFileReference).join(' '),
      { owner, draftOnly: true }
    )
  }
  // Settling and draining happen at one boundary, so nothing can slip in between.
  flushNativeChatWaitingPasteReferences(scopeKey)
  return true
}

/**
 * `keepSaving`: a composer going unavailable keeps images main is still saving, so they reach the draft,
 * and the finished images and waiting references queued behind them, so they still land in paste order.
 */
export function clearNativeChatPendingAttachments(
  scopeKey: string,
  options?: { keepSaving?: boolean }
): void {
  scopeKey = currentDraftScope(scopeKey)
  const current = pendingCache.get(scopeKey)
  if (current) {
    writePending(
      scopeKey,
      options?.keepSaving
        ? trimSettled(
            current.filter(
              (chip) =>
                !chip.pending ||
                savingImageChips.has(chip.id) ||
                waitingPasteReferences.has(chip.id)
            )
          )
        : []
    )
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
