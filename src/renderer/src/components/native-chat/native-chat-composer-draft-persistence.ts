// Persist whole memory records, journal unconfirmed changes on unload, and adopt other windows’ confirmed writes.

import { basename } from '@/lib/path'
import { isNativeChatKeptPastePath } from './native-chat-image-paste'
import { isNativeChatPastedImagePath } from '../../../../shared/native-chat-image-label'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session-attachments'
import {
  dirtyScopes,
  hasLocalChange,
  load,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  unconfirmed,
  reconcileRestoredImageChecks,
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

/** Omit launch seeds; retain durable local/server pastes, reduce other pastes to unavailable names, and drop empty records. */
function savedForm(record: DraftRecord): StoredNativeChatComposerDraft | null {
  const { unsavedText, ...saved } = record
  const images = saved.images.map((image) =>
    isNativeChatPastedImagePath(image.path) &&
    !isKeptLocalPaste(image) &&
    !isAgentSessionAttachmentStorePath(image.path)
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

/** Storage settles asynchronously; journal unconfirmed and refused writes synchronously before the window leaves. */
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

/** Before hydration, append atomically to storage’s current record and replay over the eventual loaded draft. */
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

/** Coalesce deferred typing; persist immediate edits now, with pre-hydration edits replacing and appends replaying over loaded drafts. */
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

// Adopt another window’s write only while this window has no unsaved local change.
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
        reconcileRestoredImageChecks(scopeKey, draft.images, records.get(scopeKey)?.images ?? [])
        records.set(scopeKey, draft)
      } else {
        records.delete(scopeKey)
        reconcileRestoredImageChecks(scopeKey, [])
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

/** Flush deferred changes and await every already-issued scope write; true requires commits, false means refusal/failure, and never treat a timeout as success. */
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
