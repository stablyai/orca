// The stored form of composer drafts: one localStorage record per scope, written whole from the
// draft store's memory record, and the bounds that keep all of them small.

import type { JSONContent } from '@tiptap/react'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'

const STORAGE_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'
// Why: drafts share the origin's localStorage quota (Chromium: 10 MiB of UTF-16, ~5M chars) with
// the outbox, which must always be able to save a send, so all drafts together keep to a fifth.
const MAX_STORED_TOTAL_CHARS = 1_000_000
// Why the whole budget: text given back from the outbox (up to MAX_PROMPT_BYTES of JSON per
// message) must stay saved, so one draft may push older ones out rather than go unsaved. The
// margin is for its key.
const MAX_STORED_DRAFT_CHARS = MAX_STORED_TOTAL_CHARS - 1_000

export type NativeChatComposerDraftImage = {
  id: string
  path: string
  connectionId?: string
}

export type NativeChatComposerDraft = {
  readonly text: string
  /** The editor's document for exactly `text`; dropped when the text changes without one. */
  readonly document?: JSONContent
  readonly images: readonly NativeChatComposerDraftImage[]
}

export type StoredNativeChatComposerDraft = NativeChatComposerDraft & { readonly savedAt: number }

type StoredDraftSize = { chars: number; savedAt: number }

// Size and age of each stored draft, read from storage once per run so bounds never re-parse it.
let storedDrafts: Map<string, StoredDraftSize> | null = null
let storedTotalChars = 0

export function nativeChatComposerDraftStorageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`
}

export function nativeChatComposerDraftStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the editor's own root node is restored; anything else falls back to the plain text. */
function isEditorDocument(value: unknown): value is JSONContent {
  return isRecord(value) && value.type === 'doc'
}

function parseImage(value: unknown): NativeChatComposerDraftImage | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, path, connectionId } = value
  if (typeof id !== 'string' || typeof path !== 'string' || path === '') {
    return null
  }
  return { id, path, ...(typeof connectionId === 'string' ? { connectionId } : {}) }
}

export function parseStoredNativeChatComposerDraft(
  raw: string | null
): StoredNativeChatComposerDraft | null {
  if (raw === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) {
      return null
    }
    const { text, document, images, savedAt } = value
    if (typeof text !== 'string' || typeof savedAt !== 'number' || !Array.isArray(images)) {
      return null
    }
    return {
      text,
      ...(isEditorDocument(document) ? { document } : {}),
      images: images.flatMap((image) => parseImage(image) ?? []),
      savedAt
    }
  } catch {
    return null
  }
}

function indexStoredDraft(key: string, size: StoredDraftSize): void {
  if (!storedDrafts) {
    return
  }
  storedTotalChars += size.chars - (storedDrafts.get(key)?.chars ?? 0)
  storedDrafts.set(key, size)
}

function unindexStoredDraft(key: string): void {
  storedTotalChars -= storedDrafts?.get(key)?.chars ?? 0
  storedDrafts?.delete(key)
}

/** Reads every stored draft's size once per run; unreadable records go. */
function storedDraftIndex(storage: Storage): Map<string, StoredDraftSize> {
  if (storedDrafts) {
    return storedDrafts
  }
  const index = new Map<string, StoredDraftSize>()
  const unreadable: string[] = []
  let total = 0
  for (let position = 0; position < storage.length; position += 1) {
    const key = storage.key(position)
    if (!key?.startsWith(STORAGE_KEY_PREFIX)) {
      continue
    }
    const raw = storage.getItem(key)
    const stored = parseStoredNativeChatComposerDraft(raw)
    if (raw === null || !stored) {
      unreadable.push(key)
      continue
    }
    index.set(key, { chars: key.length + raw.length, savedAt: stored.savedAt })
    total += key.length + raw.length
  }
  for (const key of unreadable) {
    storage.removeItem(key)
  }
  storedDrafts = index
  storedTotalChars = total
  return index
}

/** Indexes what storage already holds before this run's first write, so bounds count it. */
export function indexStoredNativeChatComposerDrafts(storage: Storage): void {
  try {
    storedDraftIndex(storage)
  } catch {
    // Bookkeeping only: writes still land, unbounded until a later flush indexes them.
  }
}

/** The record as stored: without its document when that alone makes it too large; null when even
 *  its text and images are. */
function serializeDraft({
  text,
  document,
  images,
  savedAt
}: StoredNativeChatComposerDraft): string | null {
  const whole = JSON.stringify({ text, ...(document ? { document } : {}), images, savedAt })
  if (whole.length <= MAX_STORED_DRAFT_CHARS) {
    return whole
  }
  if (!document) {
    return null
  }
  const withoutDocument = JSON.stringify({ text, images, savedAt })
  return withoutDocument.length <= MAX_STORED_DRAFT_CHARS ? withoutDocument : null
}

export function removeStoredNativeChatComposerDraft(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
    unindexStoredDraft(key)
  } catch {
    // Storage gone: nothing left to read back either.
  }
}

/**
 * Stores the whole record; false when storage refused it. One too large stays in memory only, and
 * its older stored copy goes so it can never come back in place of this one.
 */
export function writeStoredNativeChatComposerDraft(
  storage: Storage,
  scopeKey: string,
  draft: StoredNativeChatComposerDraft
): boolean {
  const key = nativeChatComposerDraftStorageKey(scopeKey)
  const serialized = serializeDraft(draft)
  try {
    if (serialized === null) {
      storage.removeItem(key)
      unindexStoredDraft(key)
    } else {
      storage.setItem(key, serialized)
      indexStoredDraft(key, { chars: key.length + serialized.length, savedAt: draft.savedAt })
    }
    return true
  } catch {
    return false
  }
}

/** Keeps the stored drafts within the count and total budget, dropping the oldest first. */
export function enforceStoredNativeChatComposerDraftBounds(storage: Storage): void {
  const index = storedDrafts
  if (!index) {
    return
  }
  const withinBounds = (): boolean =>
    index.size <= NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX && storedTotalChars <= MAX_STORED_TOTAL_CHARS
  if (withinBounds()) {
    return
  }
  const oldestFirst = [...index.entries()].sort((left, right) => left[1].savedAt - right[1].savedAt)
  for (const [key] of oldestFirst) {
    if (withinBounds()) {
      return
    }
    removeStoredNativeChatComposerDraft(storage, key)
  }
}

/** Removes every stored draft whose scope matches. */
export function removeStoredNativeChatComposerDraftsWhere(
  storage: Storage,
  matches: (scopeKey: string) => boolean
): void {
  try {
    for (const key of storedDraftIndex(storage).keys()) {
      if (matches(decodeURIComponent(key.slice(STORAGE_KEY_PREFIX.length)))) {
        removeStoredNativeChatComposerDraft(storage, key)
      }
    }
  } catch {
    // Cleanup only; the count and size bounds still retire these drafts.
  }
}

export function clearStoredNativeChatComposerDraftsForTests(): void {
  storedDrafts = null
  storedTotalChars = 0
  const storage = nativeChatComposerDraftStorage()
  if (!storage) {
    return
  }
  const keys: string[] = []
  for (let position = 0; position < storage.length; position += 1) {
    const key = storage.key(position)
    if (key?.startsWith(STORAGE_KEY_PREFIX)) {
      keys.push(key)
    }
  }
  for (const key of keys) {
    storage.removeItem(key)
  }
}
