// Persist whole memory records, journal unconfirmed changes on unload, and adopt other windows’ confirmed writes.

import {
  dirtyScopes,
  deferredRemovals,
  isNativeChatSetupDraft,
  hasLocalChange,
  load,
  notifyScope,
  records,
  installNativeChatDraftRecord,
  unconfirmed,
  reconcileRestoredImageChecks
} from './native-chat-composer-draft-memory'
import { scopeInputs } from './native-chat-composer-draft-input'
import { withIndependentNativeChatComposerDraft } from './native-chat-composer-draft-addition'
import {
  writeNativeChatComposerDraftJournalBatch,
  type NativeChatDraftJournalAddition
} from './native-chat-composer-draft-journal-batch'
import { draftCustody, handbackReceiptKey } from './native-chat-composer-draft-custody'
import {
  markNativeChatDraftHandbacksDurable,
  projectStoredNativeChatDraftCustody
} from './native-chat-composer-draft-receipt-proof'
import {
  authorizedRemovals,
  flushNativeChatComposerDrafts,
  resetNativeChatComposerDraftCommitsForTests,
  scheduleNativeChatComposerDraftFlush,
  setNativeChatComposerDraftChannel
} from './native-chat-composer-draft-commit'
export {
  flushNativeChatComposerDrafts,
  nativeChatComposerDraftWriteSettled,
  nativeChatComposerDraftWritesSettled
} from './native-chat-composer-draft-commit'
import { noticeNativeChatDraftReceipts } from './native-chat-composer-draft-receipt-events'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
export { unavailableNativeChatComposerDraftImage } from './native-chat-composer-draft-restore'
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
 *  the shared journal in one write: whole snapshots for drafts whose value is complete. Input over
 *  a still unread base is never a whole snapshot: its pending hand-backs go as identified
 *  additions, an edited partial view as one addition replacing this run's earlier ones, and its
 *  own additions are already journaled. */
function journalUnconfirmed(): void {
  flushNativeChatComposerDrafts()
  const snapshots = new Map<string, { draft: StoredNativeChatComposerDraft | null; at: number }>()
  const additions: NativeChatDraftJournalAddition[] = []
  const superseded = new Set<string>()
  for (const [scopeKey, change] of unconfirmed) {
    const pending = draftCustody.get(scopeKey)?.pending ?? []
    const input = scopeInputs.get(scopeKey)
    if (!input || input.kind === 'replaced') {
      if (!pending.length) {
        snapshots.set(scopeKey, change)
      } else if (input) {
        // Its replaced content, without the receipts of returns it does not hold yet.
        const owed = new Set(pending.map(({ receipt }) => handbackReceiptKey(receipt)))
        const handbacks = change.draft?.handbacks?.filter(
          (receipt) => !owed.has(handbackReceiptKey(receipt))
        )
        const { handbacks: _owed, ...content } = change.draft ?? { text: '', images: [] }
        snapshots.set(scopeKey, {
          at: change.at,
          draft: change.draft && {
            ...content,
            savedAt: change.draft.savedAt,
            ...(handbacks?.length ? { handbacks } : {})
          }
        })
      }
      if (!pending.length) {
        continue
      }
    }
    const at = draftCustody.get(scopeKey)?.savedAt ?? change.at
    // An edited partial view is one input; it joins the first pending hand-back, if any.
    const record = input?.kind === 'partial' && !input.appends ? records.get(scopeKey) : undefined
    const view = record && {
      text: record.text === record.unsavedText ? '' : record.text,
      images: record.images,
      ...(record.document ? { document: record.document } : {}),
      ...(record.pastedTextFiles ? { pastedTextFiles: record.pastedTextFiles } : {})
    }
    if (view) {
      superseded.add(scopeKey)
      if (!pending.length && (view.text !== '' || view.images.length > 0)) {
        additions.push({ scopeKey, at, addition: view })
      }
    }
    pending.forEach((handback, index) =>
      additions.push({
        scopeKey,
        at,
        addition:
          index === 0 && view
            ? withIndependentNativeChatComposerDraft(view, handback.contribution)
            : handback.contribution,
        custody: { handback: handback.receipt, sourcePaths: handback.sourcePaths }
      })
    )
  }
  const witness = writeNativeChatComposerDraftJournalBatch({ snapshots, additions, superseded })
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

/** Coalesce deferred typing and persist immediate edits now; each write resolves the scope's
 *  unresolved input at the base it actually reads. */
export function persistNativeChatComposerDraft(
  scopeKey: string,
  persist: 'immediate' | 'deferred'
): void {
  installFlushOnHide()
  if (records.has(scopeKey)) {
    deferredRemovals.delete(scopeKey)
    authorizedRemovals.delete(scopeKey)
  }
  dirtyScopes.add(scopeKey)
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
  load.attempt?.deletions.push(matches)
}

// Adopt another window’s committed write, a read of what storage holds, only while this window
// has no unsaved local change; that change will itself commit against this record.
function adoptForeignChange(message: unknown): void {
  const scopeKey =
    typeof message === 'object' && message !== null && 'scopeKey' in message
      ? message.scopeKey
      : null
  if (typeof scopeKey !== 'string' || hasLocalChange(scopeKey) || scopeInputs.has(scopeKey)) {
    return
  }
  void nativeChatComposerDraftStorage()
    .read(scopeKey)
    .then((value) => {
      if (
        hasLocalChange(scopeKey) ||
        scopeInputs.has(scopeKey) ||
        draftCustody.get(scopeKey)?.pending.length
      ) {
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
