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
  type DraftAppend
} from './native-chat-composer-draft-memory'
import { withIndependentNativeChatComposerDraft } from './native-chat-composer-draft-addition'
import { pruneNativeChatComposerDraftJournal } from './native-chat-composer-draft-journal'
import {
  writeNativeChatComposerDraftJournalBatch,
  type NativeChatDraftJournalAddition
} from './native-chat-composer-draft-journal-batch'
import { draftCustody, handbacksAtBase } from './native-chat-composer-draft-custody'
import {
  confirmNativeChatDraftCustody,
  markNativeChatDraftHandbacksDurable,
  projectStoredNativeChatDraftCustody
} from './native-chat-composer-draft-receipt-proof'
import {
  authorizedRemovals,
  broadcastNativeChatComposerDraft,
  completeDeferredRemovals,
  flushNativeChatComposerDrafts,
  resetNativeChatComposerDraftCommitsForTests,
  scheduleNativeChatComposerDraftFlush,
  setNativeChatComposerDraftChannel,
  track
} from './native-chat-composer-draft-commit'
export {
  flushNativeChatComposerDrafts,
  nativeChatComposerDraftWriteSettled,
  nativeChatComposerDraftWritesSettled
} from './native-chat-composer-draft-commit'
import { noticeNativeChatDraftReceipts } from './native-chat-composer-draft-receipt-events'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
export { unavailableNativeChatComposerDraftImage } from './native-chat-composer-draft-restore'
import { savedForm } from './native-chat-composer-draft-saved-form'
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

let flushOnHideInstalled = false
let channelInstalled = false

/** Storage settles asynchronously; before the window leaves, every unconfirmed change goes into
 *  the shared journal in one write: whole snapshots for drafts whose base is known, and for a
 *  draft still waiting for its base, its pending hand-backs as coalesced identified additions. */
function journalUnconfirmed(): void {
  flushNativeChatComposerDrafts()
  const snapshots = new Map<string, { draft: StoredNativeChatComposerDraft | null; at: number }>()
  const additions: NativeChatDraftJournalAddition[] = []
  for (const [scopeKey, change] of unconfirmed) {
    const pending = draftCustody.get(scopeKey)?.pending ?? []
    if (!pending.length) {
      snapshots.set(scopeKey, change)
      continue
    }
    // What was typed into the partial view joins the first pending hand-back.
    const typed = records.get(scopeKey) ?? { text: '', images: [] }
    pending.forEach((handback, index) =>
      additions.push({
        scopeKey,
        at: draftCustody.get(scopeKey)?.savedAt ?? change.at,
        addition:
          index === 0
            ? withIndependentNativeChatComposerDraft(typed, handback.contribution)
            : handback.contribution,
        custody: { handback: handback.receipt, sourcePaths: handback.sourcePaths }
      })
    )
  }
  const witness = writeNativeChatComposerDraftJournalBatch({ snapshots, additions })
  for (const scopeKey of witness.snapshots) {
    markNativeChatDraftHandbacksDurable(scopeKey, snapshots.get(scopeKey)?.draft)
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
        handbacks: handbacksAtBase(scopeKey, base),
        savedAt: nextSavedAt()
      })
      return saved
    })
    .then(
      () => {
        entry.committed = true
        confirmNativeChatDraftCustody(scopeKey, saved)
        pruneNativeChatComposerDraftJournal(scopeKey, appendedAt)
        broadcastNativeChatComposerDraft(scopeKey)
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
    authorizedRemovals.delete(scopeKey)
  }
  // A scope waiting for its base composes everything onto it at its own read, appends included.
  const partial = Boolean(draftCustody.get(scopeKey)?.pending.length)
  if (!load.hydrated && append && !partial && !load.editedBeforeLoad.has(scopeKey)) {
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
  scheduleNativeChatComposerDraftFlush(PERSIST_DEBOUNCE_MS)
}

/** An authorized deletion: the saved record goes, receipts and all, and nothing at the base survives it. */
export function removeNativeChatComposerDraftRecord(scopeKey: string): void {
  authorizedRemovals.add(scopeKey)
  persistNativeChatComposerDraft(scopeKey, 'immediate')
}

/** A deletion also applies to drafts a load still in flight brings back. */
export function deleteLoadingNativeChatComposerDraftsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft) => boolean
): void {
  if (!load.hydrated) {
    load.deletionsBeforeLoad.push(matches)
  }
}

// Adopt another window’s committed write, a read of what storage holds, only while this window
// has no unsaved local change; that change will itself commit against this record.
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
      if (hasLocalChange(scopeKey) || draftCustody.get(scopeKey)?.pending.length) {
        return
      }
      if (isNativeChatSetupDraft(scopeKey) && value != null) {
        return
      }
      const draft = parseStoredNativeChatComposerDraft(value)
      if (draft) {
        installStoredNativeChatComposerDraft(scopeKey, draft, draft.handbacks ?? [])
      } else {
        projectStoredNativeChatDraftCustody(scopeKey, null, [])
        installNativeChatDraftRecord(scopeKey)
        reconcileRestoredImageChecks(scopeKey, [])
      }
      noticeNativeChatDraftReceipts(scopeKey)
      notifyScope(scopeKey)
    })
    .catch(() => {})
}

export function installNativeChatComposerDraftBroadcast(): void {
  if (channelInstalled || typeof BroadcastChannel === 'undefined') {
    return
  }
  channelInstalled = true
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => adoptForeignChange(event.data)
  // Why: Node's channel (unit tests) would otherwise keep the process alive.
  if ('unref' in channel && typeof channel.unref === 'function') {
    channel.unref()
  }
  setNativeChatComposerDraftChannel(channel)
}

export function resetNativeChatComposerDraftPersistenceForTests(): void {
  resetNativeChatComposerDraftCommitsForTests()
  channelInstalled = false
  if (flushOnHideInstalled) {
    flushOnHideInstalled = false
    window.removeEventListener('pagehide', journalUnconfirmed)
    window.removeEventListener('beforeunload', journalUnconfirmed)
    document.removeEventListener('visibilitychange', journalWhenHidden)
  }
}
