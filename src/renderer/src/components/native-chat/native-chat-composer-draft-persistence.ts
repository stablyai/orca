import {
  broadcastNativeChatComposerDraftChange,
  resetNativeChatComposerDraftBroadcast
} from './native-chat-composer-draft-broadcast'
export { installNativeChatComposerDraftBroadcast } from './native-chat-composer-draft-broadcast'
import { savedNativeChatComposerDraftForm } from './native-chat-composer-draft-saved-value'
import {
  nativeChatDraftRecordReturn,
  recordNativeChatDraftReturnOperation,
  type NativeChatDraftReturnProduct
} from './native-chat-draft-return-products'
export {
  savedNativeChatComposerDraftForm,
  isKeptLocalPaste,
  unavailableNativeChatComposerDraftImage
} from './native-chat-composer-draft-saved-value'
import {
  inFlight,
  scopeWrites,
  track,
  resetNativeChatDraftWriteOperations
} from './native-chat-composer-draft-write-operations'
export {
  nativeChatComposerDraftOperations,
  nativeChatComposerDraftOperationScopes,
  nativeChatComposerDraftForeignRead,
  supersedeNativeChatComposerDraftRead,
  trackNativeChatComposerDraftRemoval
} from './native-chat-composer-draft-write-operations'
// Persist whole memory records, journal unconfirmed changes on unload, and adopt other windows’ confirmed writes.

import {
  dirtyScopes,
  deferredRemovals,
  isNativeChatSetupDraft,
  load,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  unconfirmed,
  type AppendBeforeLoad,
  type DraftAppend,
  type UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'
import {
  journalNativeChatComposerDraftChanges,
  pruneNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  nativeChatComposerDraftStorage,
  KEEP_NATIVE_CHAT_DRAFT,
  parseStoredNativeChatComposerDraft,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const PERSIST_DEBOUNCE_MS = 250

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHideInstalled = false

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
  if (change.retired) {
    return
  }
  if (unconfirmed.get(scopeKey) === change) {
    unconfirmed.delete(scopeKey)
    if (refusedScopes.delete(scopeKey)) {
      notifyScope(scopeKey)
    }
  }
  pruneNativeChatComposerDraftJournal(scopeKey, change.at)
  broadcastNativeChatComposerDraftChange(scopeKey)
  completeDeferredRemovals(scopeKey, change.at)
}

function refuse(scopeKey: string, change: UnconfirmedDraftChange, error: unknown): void {
  if (change.retired || unconfirmed.get(scopeKey) !== change) {
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

function persist(scopeKey: string, product?: NativeChatDraftReturnProduct): void {
  // A refused deliberate setup removal retries only null, even beside new live input.
  const record = isNativeChatSetupDraft(scopeKey) ? undefined : records.get(scopeKey)
  const draft = record ? savedNativeChatComposerDraftForm(record) : null
  const change: UnconfirmedDraftChange = { draft, at: draft?.savedAt ?? nextSavedAt() }
  recordNativeChatDraftReturnOperation(
    product?.after === record ? product : nativeChatDraftRecordReturn(record),
    change
  )
  const loaded = record ? load.attempt?.installed.get(record) : undefined
  if (loaded) {
    loaded.write = change
  }
  unconfirmed.set(scopeKey, change)
  const storage = nativeChatComposerDraftStorage()
  const written = storage
    .update(scopeKey, (stored) => {
      if (change.retired) {
        return KEEP_NATIVE_CHAT_DRAFT
      }
      change.applied = { input: stored, output: draft }
      return draft
    })
    .then(
      () => {
        confirm(scopeKey, change)
        return true
      },
      (error: unknown) => {
        refuse(scopeKey, change, error)
        return false
      }
    )
  track(scopeKey, written, change)
}

export function flushNativeChatComposerDrafts(returned?: {
  scopeKey: string
  product?: NativeChatDraftReturnProduct
}): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const scopeKey of dirtyScopes) {
    if (deferredRemovals.has(scopeKey)) {
      continue
    }
    dirtyScopes.delete(scopeKey)
    persist(scopeKey, returned?.scopeKey === scopeKey ? returned.product : undefined)
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
function appendBeforeLoad(
  scopeKey: string,
  append: DraftAppend,
  product?: NativeChatDraftReturnProduct
): void {
  load.appendSequence += 1
  const entry: AppendBeforeLoad = { sequence: load.appendSequence, append, committed: false }
  recordNativeChatDraftReturnOperation(product, entry)
  load.appendsBeforeLoad.set(scopeKey, [...(load.appendsBeforeLoad.get(scopeKey) ?? []), entry])
  const owner = records.get(scopeKey)?.owner
  const appendedAt = records.get(scopeKey)?.savedAt ?? 0
  const empty: StoredNativeChatComposerDraft = { text: '', images: [], savedAt: 0 }
  const written = nativeChatComposerDraftStorage()
    .update(scopeKey, (stored) => {
      if (entry.retired) {
        return KEEP_NATIVE_CHAT_DRAFT
      }
      const base = parseStoredNativeChatComposerDraft(stored) ?? empty
      const output = savedNativeChatComposerDraftForm({
        ...append({ ...base, ...(base.owner || !owner ? {} : { owner }) }),
        savedAt: nextSavedAt()
      })
      entry.applied = { input: stored, output }
      return output
    })
    .then(
      () => {
        if (entry.retired) {
          return true
        }
        entry.committed = true
        pruneNativeChatComposerDraftJournal(scopeKey, appendedAt)
        broadcastNativeChatComposerDraftChange(scopeKey)
        completeDeferredRemovals(scopeKey, appendedAt)
        return true
      },
      (error: unknown) => {
        if (entry.retired) {
          return false
        }
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
  track(scopeKey, written, entry)
}

/** Coalesce deferred typing; persist immediate edits now, with pre-hydration edits replacing and appends replaying over loaded drafts. */
export function persistNativeChatComposerDraft(
  scopeKey: string,
  persist: 'immediate' | 'deferred',
  append?: DraftAppend,
  product?: NativeChatDraftReturnProduct
): void {
  installFlushOnHide()
  if (records.has(scopeKey)) {
    deferredRemovals.delete(scopeKey)
  }
  if (!load.hydrated && append && !load.editedBeforeLoad.has(scopeKey)) {
    appendBeforeLoad(scopeKey, append, product)
    return
  }
  dirtyScopes.add(scopeKey)
  if (!load.hydrated) {
    load.editedBeforeLoad.add(scopeKey)
  }
  if (persist === 'immediate') {
    flushNativeChatComposerDrafts({ scopeKey, product })
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
  resetNativeChatComposerDraftBroadcast()
  if (flushOnHideInstalled) {
    flushOnHideInstalled = false
    window.removeEventListener('pagehide', journalUnconfirmed)
    window.removeEventListener('beforeunload', journalUnconfirmed)
    document.removeEventListener('visibilitychange', journalWhenHidden)
  }
  resetNativeChatDraftWriteOperations()
}
