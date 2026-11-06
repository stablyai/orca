// Persist whole memory records, journal unconfirmed changes on unload, and adopt other windows’ confirmed writes.

import {
  dirtyScopes,
  deferredRemovals,
  isNativeChatSetupDraft,
  hasLocalChange,
  load,
  nextSavedAt,
  notifyScope,
  records,
  installNativeChatDraftRecord,
  refusedScopes,
  unconfirmed,
  reconcileRestoredImageChecks,
  type AppendBeforeLoad,
  type DraftAppend,
  type UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'
import {
  journalNativeChatComposerDraftChanges,
  pruneNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  draftCustody,
  markNativeChatDraftHandbacksDurable,
  ownedHandbacksMissingFrom,
  reassertNativeChatDraftHandbacks
} from './native-chat-composer-draft-custody'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
export { unavailableNativeChatComposerDraftImage } from './native-chat-composer-draft-restore'
import {
  journalOwedNativeChatDraftHandbacks,
  nextStoredNativeChatComposerDraft,
  savedForm
} from './native-chat-composer-draft-saved-form'
export {
  currentStoredNativeChatComposerDraft,
  isKeptLocalPaste
} from './native-chat-composer-draft-saved-form'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
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

function completeDeferredRemovals(destinationScope: string, savedAt: number): void {
  let released = false
  for (const [sourceScope, pending] of deferredRemovals) {
    if (pending.destinationScope === destinationScope && savedAt >= pending.savedAt) {
      deferredRemovals.delete(sourceScope)
      released = true
    }
  }
  if (released) {
    flushNativeChatComposerDrafts()
  }
}

function confirm(scopeKey: string, change: UnconfirmedDraftChange): void {
  markNativeChatDraftHandbacksDurable(scopeKey, change.draft)
  if (unconfirmed.get(scopeKey) === change) {
    unconfirmed.delete(scopeKey)
    if (refusedScopes.delete(scopeKey)) {
      notifyScope(scopeKey)
    }
  }
  pruneNativeChatComposerDraftJournal(scopeKey, change.at)
  channel?.postMessage({ scopeKey })
  completeDeferredRemovals(scopeKey, change.at)
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
  journalOwedNativeChatDraftHandbacks(scopeKey)
}

function persist(scopeKey: string): void {
  const draft = nextStoredNativeChatComposerDraft(scopeKey)
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
    if (deferredRemovals.has(scopeKey)) {
      continue
    }
    dirtyScopes.delete(scopeKey)
    persist(scopeKey)
  }
}

/** Storage settles asynchronously; journal unconfirmed and refused writes synchronously before the window leaves. */
function journalUnconfirmed(): void {
  flushNativeChatComposerDrafts()
  for (const scopeKey of journalNativeChatComposerDraftChanges(unconfirmed)) {
    markNativeChatDraftHandbacksDurable(scopeKey, unconfirmed.get(scopeKey)?.draft)
  }
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
  let saved: StoredNativeChatComposerDraft | null = null
  const written = nativeChatComposerDraftStorage()
    .update(scopeKey, (stored) => {
      const base = parseStoredNativeChatComposerDraft(stored) ?? empty
      saved = savedForm({
        ...append({ ...base, ...(base.owner || !owner ? {} : { owner }) }),
        savedAt: nextSavedAt()
      })
      return saved
    })
    .then(
      () => {
        entry.committed = true
        markNativeChatDraftHandbacksDurable(scopeKey, saved)
        pruneNativeChatComposerDraftJournal(scopeKey, appendedAt)
        channel?.postMessage({ scopeKey })
        completeDeferredRemovals(scopeKey, appendedAt)
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
  if (records.has(scopeKey)) {
    deferredRemovals.delete(scopeKey)
  }
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
      if (isNativeChatSetupDraft(scopeKey) && value != null) {
        return
      }
      const draft = parseStoredNativeChatComposerDraft(value)
      // A writer that never saw this window's adoption must not erase its receipt.
      const missing = ownedHandbacksMissingFrom(scopeKey, draft)
      if (draft) {
        installStoredNativeChatComposerDraft(scopeKey, draft, draft.handbacks ?? [])
      } else {
        draftCustody.delete(scopeKey)
        installNativeChatDraftRecord(scopeKey)
        reconcileRestoredImageChecks(scopeKey, [])
      }
      if (missing.length) {
        reassertNativeChatDraftHandbacks(scopeKey, missing, nextSavedAt())
        dirtyScopes.add(scopeKey)
        flushNativeChatComposerDrafts()
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
