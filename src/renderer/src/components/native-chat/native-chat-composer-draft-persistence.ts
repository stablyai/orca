// Keeps storage a copy of the draft store's memory: writes each changed draft whole, journals what
// storage has not confirmed when the window goes away, and follows other windows' writes.

import { basename } from '@/lib/path'
import { isNativeChatKeptPastePath, isNativeChatPastedImagePath } from './native-chat-image-paste'
import {
  dirtyScopes,
  hasLocalChange,
  load,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  unconfirmed,
  unverifiedScopes,
  type AppendBeforeLoad,
  type DraftAppend,
  type DraftRecord,
  type UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'
import {
  journalNativeChatComposerDraftChanges,
  pruneNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  type NativeChatComposerDraftImage,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const PERSIST_DEBOUNCE_MS = 250
const CHANNEL_NAME = 'orca-native-chat-composer-drafts'

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHideInstalled = false
const inFlight = new Set<Promise<boolean>>()
// Per scope, the writes not yet settled: each resolves true once committed, false when refused.
const scopeWrites = new Map<string, Set<Promise<boolean>>>()
let channel: BroadcastChannel | null = null

/** An image the draft names but can no longer send, so the user can attach it again. */
export function unavailableNativeChatComposerDraftImage(
  image: NativeChatComposerDraftImage
): NativeChatComposerDraftImage {
  return image.unavailableName === undefined
    ? { id: image.id, path: '', unavailableName: basename(image.path) }
    : image
}

/** A local paste in Orca's paste folder: it outlives the run, so a restore can show and send it. */
export function isKeptLocalPaste(image: NativeChatComposerDraftImage): boolean {
  return !image.connectionId && isNativeChatKeptPastePath(image.path)
}

/** What storage keeps: not an unsaved launch-seed copy, and a paste outside Orca's paste folder
 *  (over SSH, or from before it) only by name. Null when nothing is left. */
function savedForm(record: DraftRecord): StoredNativeChatComposerDraft | null {
  const { unsavedText, ...saved } = record
  const images = saved.images.map((image) =>
    isNativeChatPastedImagePath(image.path) && !isKeptLocalPaste(image)
      ? unavailableNativeChatComposerDraftImage(image)
      : image
  )
  const text = saved.text === unsavedText ? '' : saved.text
  if (text === '' && images.length === 0) {
    return null
  }
  return { ...saved, text, images }
}

function confirm(scopeKey: string, change: UnconfirmedDraftChange): void {
  if (unconfirmed.get(scopeKey) === change) {
    unconfirmed.delete(scopeKey)
    if (refusedScopes.delete(scopeKey)) {
      notifyScope(scopeKey)
    }
  }
  pruneNativeChatComposerDraftJournal(scopeKey, change.at)
  channel?.postMessage({ scopeKey })
}

function refuse(scopeKey: string, change: UnconfirmedDraftChange, error: unknown): void {
  if (unconfirmed.get(scopeKey) !== change) {
    return
  }
  unconfirmed.delete(scopeKey)
  dirtyScopes.add(scopeKey)
  if (!refusedScopes.has(scopeKey)) {
    console.warn('[native-chat-drafts] a draft could not be saved; it is kept in memory', error)
    refusedScopes.add(scopeKey)
    notifyScope(scopeKey)
  }
}

function persist(scopeKey: string): void {
  const record = records.get(scopeKey)
  const draft = record ? savedForm(record) : null
  const change: UnconfirmedDraftChange = { draft, at: draft?.savedAt ?? nextSavedAt() }
  unconfirmed.set(scopeKey, change)
  const storage = nativeChatComposerDraftStorage()
  const written = (draft ? storage.write(scopeKey, draft) : storage.remove([scopeKey])).then(
    () => {
      confirm(scopeKey, change)
      return true
    },
    (error: unknown) => {
      refuse(scopeKey, change, error)
      return false
    }
  )
  track(scopeKey, written)
}

function track(scopeKey: string, written: Promise<boolean>): void {
  inFlight.add(written)
  const pending = scopeWrites.get(scopeKey) ?? new Set()
  scopeWrites.set(scopeKey, pending)
  pending.add(written)
  void written.finally(() => {
    inFlight.delete(written)
    pending.delete(written)
    if (pending.size === 0 && scopeWrites.get(scopeKey) === pending) {
      scopeWrites.delete(scopeKey)
    }
  })
}

export function flushNativeChatComposerDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const scopeKey of dirtyScopes) {
    dirtyScopes.delete(scopeKey)
    persist(scopeKey)
  }
}

/** Why: storage commits after this task, so what it has not confirmed when the window goes away
 *  is also written synchronously and replayed by the next load, a refused draft included. */
function journalUnconfirmed(): void {
  flushNativeChatComposerDrafts()
  journalNativeChatComposerDraftChanges(unconfirmed)
}

function journalWhenHidden(): void {
  if (document.visibilityState === 'hidden') {
    journalUnconfirmed()
  }
}

function installFlushOnHide(): void {
  if (
    flushOnHideInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof document === 'undefined'
  ) {
    return
  }
  flushOnHideInstalled = true
  window.addEventListener('pagehide', journalUnconfirmed)
  window.addEventListener('beforeunload', journalUnconfirmed)
  document.addEventListener('visibilitychange', journalWhenHidden)
}

/** Before the load lands, memory may not hold the saved draft, so an append is written onto what
 *  storage holds, read and written as one change. The loaded draft gets it again on landing. */
function appendBeforeLoad(scopeKey: string, append: DraftAppend): void {
  load.appendSequence += 1
  const entry: AppendBeforeLoad = { sequence: load.appendSequence, append, committed: false }
  load.appendsBeforeLoad.set(scopeKey, [...(load.appendsBeforeLoad.get(scopeKey) ?? []), entry])
  const owner = records.get(scopeKey)?.owner
  const appendedAt = records.get(scopeKey)?.savedAt ?? 0
  const empty: StoredNativeChatComposerDraft = { text: '', images: [], savedAt: 0 }
  const written = nativeChatComposerDraftStorage()
    .update(scopeKey, (stored) => {
      const base = parseStoredNativeChatComposerDraft(stored) ?? empty
      return savedForm({
        ...append({ ...base, ...(base.owner || !owner ? {} : { owner }) }),
        savedAt: nextSavedAt()
      })
    })
    .then(
      () => {
        entry.committed = true
        pruneNativeChatComposerDraftJournal(scopeKey, appendedAt)
        channel?.postMessage({ scopeKey })
        return true
      },
      (error: unknown) => {
        if (!refusedScopes.has(scopeKey)) {
          console.warn(
            '[native-chat-drafts] a draft could not be saved; it is kept in memory',
            error
          )
          refusedScopes.add(scopeKey)
          notifyScope(scopeKey)
        }
        return false
      }
    )
  track(scopeKey, written)
}

/** Marks a scope changed in memory: `deferred` coalesces typing into one write, `immediate`
 *  writes now. Before the startup load lands, an edit wins over the loaded draft and an append
 *  is applied again on top of it. */
export function persistNativeChatComposerDraft(
  scopeKey: string,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend
): void {
  installFlushOnHide()
  if (!load.hydrated && append && !load.editedBeforeLoad.has(scopeKey)) {
    appendBeforeLoad(scopeKey, append)
    return
  }
  dirtyScopes.add(scopeKey)
  if (!load.hydrated) {
    load.editedBeforeLoad.add(scopeKey)
  }
  if (persist === 'immediate') {
    flushNativeChatComposerDrafts()
    return
  }
  flushTimer ??= setTimeout(flushNativeChatComposerDrafts, PERSIST_DEBOUNCE_MS)
}

/** A deletion also applies to drafts a load still in flight brings back. */
export function deleteLoadingNativeChatComposerDraftsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft) => boolean
): void {
  if (!load.hydrated) {
    load.deletionsBeforeLoad.push(matches)
  }
}

function addsAnImage(
  draft: StoredNativeChatComposerDraft,
  previous: DraftRecord | undefined
): boolean {
  const held = new Set(previous?.images.map((image) => `${image.id}\0${image.path}`))
  return draft.images.some((image) => !held.has(`${image.id}\0${image.path}`))
}

// Why: another window of the same app (two web-client tabs) can send or edit this draft; its write
// replaces what this window holds unless this window has a change of its own not yet saved.
function adoptForeignChange(message: unknown): void {
  const scopeKey =
    typeof message === 'object' && message !== null && 'scopeKey' in message
      ? message.scopeKey
      : null
  if (typeof scopeKey !== 'string' || hasLocalChange(scopeKey)) {
    return
  }
  void nativeChatComposerDraftStorage()
    .read(scopeKey)
    .then((value) => {
      if (hasLocalChange(scopeKey)) {
        return
      }
      const draft = parseStoredNativeChatComposerDraft(value)
      if (draft) {
        // Why: images this window already checked stay checked, so their chips don't flash.
        if (addsAnImage(draft, records.get(scopeKey))) {
          unverifiedScopes.add(scopeKey)
        }
        records.set(scopeKey, draft)
      } else {
        records.delete(scopeKey)
      }
      notifyScope(scopeKey)
    })
    .catch(() => {})
}

export function installNativeChatComposerDraftBroadcast(): void {
  if (channel || typeof BroadcastChannel === 'undefined') {
    return
  }
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => adoptForeignChange(event.data)
  // Why: Node's channel (unit tests) would otherwise keep the process alive.
  if ('unref' in channel && typeof channel.unref === 'function') {
    channel.unref()
  }
}

/**
 * Settles once every write of this scope issued before the call has: true only when IndexedDB
 * completed each transaction, false when one was refused or failed. A change still waiting for its
 * deferred write is issued first, so it is included. Never settles on a timeout.
 */
export async function nativeChatComposerDraftWriteSettled(scopeKey: string): Promise<boolean> {
  if (dirtyScopes.has(scopeKey)) {
    flushNativeChatComposerDrafts()
  }
  const pending = scopeWrites.get(scopeKey)
  return pending ? (await Promise.all(pending)).every(Boolean) : true
}

/** Settles once every write issued so far has been confirmed or refused. */
export async function nativeChatComposerDraftWritesSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight)
  }
}

export function resetNativeChatComposerDraftPersistenceForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  channel?.close()
  channel = null
  if (flushOnHideInstalled) {
    flushOnHideInstalled = false
    window.removeEventListener('pagehide', journalUnconfirmed)
    window.removeEventListener('beforeunload', journalUnconfirmed)
    document.removeEventListener('visibilitychange', journalWhenHidden)
  }
  inFlight.clear()
  scopeWrites.clear()
}
