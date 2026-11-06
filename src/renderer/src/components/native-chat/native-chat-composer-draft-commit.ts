// Every draft write commits through storage.update against the scope's actual stored record; an
// authorized deletion is the one blind removal. One settlement per issued write.

import {
  deferredRemovals,
  dirtyScopes,
  isNativeChatSetupDraft,
  nextSavedAt,
  notifyScope,
  records,
  refusedScopes,
  unconfirmed,
  type UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'
import { pruneNativeChatComposerDraftJournal } from './native-chat-composer-draft-journal'
import { draftCustody, handbackReceiptKey } from './native-chat-composer-draft-custody'
import { confirmNativeChatDraftCustody } from './native-chat-composer-draft-receipt-proof'
import { nativeChatDraftAtBase } from './native-chat-composer-draft-base'
import {
  deliverNativeChatDraftReceiptCompletion,
  publishNativeChatDraftReceipts
} from './native-chat-composer-draft-receipt-events'
import { advanceNativeChatDraftRetirements } from './native-chat-composer-draft-retirement'
import {
  journalOwedNativeChatDraftHandbacks,
  nextStoredNativeChatComposerDraft
} from './native-chat-composer-draft-saved-form'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  type NativeChatDraftHandbackReceipt,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

let flushTimer: ReturnType<typeof setTimeout> | null = null
const inFlight = new Set<Promise<boolean>>()
// Per scope, the writes not yet settled: each resolves true once committed, false when refused.
const scopeWrites = new Map<string, Set<Promise<boolean>>>()
/** Scopes whose saved record an authorized deletion removes, receipts and all. */
export const authorizedRemovals = new Set<string>()
let channel: BroadcastChannel | null = null

export function setNativeChatComposerDraftChannel(next: BroadcastChannel | null): void {
  channel?.close()
  channel = next
}

export function broadcastNativeChatComposerDraft(scopeKey: string): void {
  channel?.postMessage({ scopeKey })
}

export function completeDeferredRemovals(destinationScope: string, savedAt: number): void {
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
  confirmNativeChatDraftCustody(scopeKey, change.draft)
  if (unconfirmed.get(scopeKey) === change) {
    unconfirmed.delete(scopeKey)
    if (refusedScopes.delete(scopeKey)) {
      notifyScope(scopeKey)
    }
  }
  if (!change.draft) {
    authorizedRemovals.delete(scopeKey)
  }
  const custody = draftCustody.get(scopeKey)
  change.journaled?.forEach((key) => custody?.journaled.delete(key))
  pruneNativeChatComposerDraftJournal(scopeKey, change.at, !change.draft, change.journaled)
  broadcastNativeChatComposerDraft(scopeKey)
  completeDeferredRemovals(scopeKey, change.at)
  wakeNativeChatDraftRetirements(scopeKey)
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
  wakeNativeChatDraftRetirements(scopeKey)
}

/** The one wake every proof transition of a scope reaches: requested retirements advance, those
 *  completed are delivered to their observers, then the scope's listeners hear their progress. */
export function wakeNativeChatDraftRetirements(scopeKey: string, announce = true): void {
  const retiring = draftCustody.get(scopeKey)?.retiring.size ?? 0
  const { metadata, completed } = advanceNativeChatDraftRetirements(scopeKey)
  for (const receipt of metadata) {
    retireStoredNativeChatDraftReceipt(scopeKey, receipt)
  }
  for (const key of completed) {
    deliverNativeChatDraftReceiptCompletion(scopeKey, key)
  }
  // A request alone announces only a retirement it advanced, so listeners cannot loop on it.
  if (announce || (draftCustody.get(scopeKey)?.retiring.size ?? 0) !== retiring) {
    publishNativeChatDraftReceipts(scopeKey)
  }
}

function persist(scopeKey: string): void {
  const removal =
    isNativeChatSetupDraft(scopeKey) ||
    (authorizedRemovals.has(scopeKey) && !records.has(scopeKey) && !draftCustody.has(scopeKey))
  const draft = removal ? null : nextStoredNativeChatComposerDraft(scopeKey)
  const change: UnconfirmedDraftChange = { draft, at: draft?.savedAt ?? nextSavedAt() }
  unconfirmed.set(scopeKey, change)
  const storage = nativeChatComposerDraftStorage()
  const written = (
    removal
      ? storage.remove([scopeKey])
      : storage.update(scopeKey, (value) => {
          // The transaction's own read: the write is decided against what is actually stored.
          change.draft = nativeChatDraftAtBase(scopeKey, parseStoredNativeChatComposerDraft(value))
          change.at = change.draft?.savedAt ?? change.at
          change.journaled = [...(draftCustody.get(scopeKey)?.journaled ?? [])]
          return change.draft
        })
  ).then(
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

/** Retirement changes only the stored record's receipts; it never writes this memory's content. */
function retireStoredNativeChatDraftReceipt(
  scopeKey: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const key = handbackReceiptKey(receipt)
  let written: StoredNativeChatComposerDraft | null = null
  const settled = nativeChatComposerDraftStorage()
    .update(scopeKey, (value) => {
      const stored = parseStoredNativeChatComposerDraft(value)
      const handbacks = (stored?.handbacks ?? []).filter((held) => handbackReceiptKey(held) !== key)
      if (!stored || (stored.text === '' && stored.images.length === 0 && !handbacks.length)) {
        return null
      }
      const { handbacks: _retired, ...content } = stored
      written = handbacks.length ? { ...content, handbacks } : content
      return written
    })
    .then(
      () => {
        confirmNativeChatDraftCustody(scopeKey, written)
        broadcastNativeChatComposerDraft(scopeKey)
        wakeNativeChatDraftRetirements(scopeKey)
        return true
      },
      // Still retired here: every later write at the base leaves it out.
      () => false
    )
  track(scopeKey, settled)
}

export function track(scopeKey: string, written: Promise<boolean>): void {
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

export function hasPendingNativeChatComposerDraftWrite(scopeKey: string): boolean {
  return scopeWrites.has(scopeKey)
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

export function scheduleNativeChatComposerDraftFlush(delayMs: number): void {
  flushTimer ??= setTimeout(flushNativeChatComposerDrafts, delayMs)
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

export function resetNativeChatComposerDraftCommitsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  setNativeChatComposerDraftChannel(null)
  inFlight.clear()
  scopeWrites.clear()
  authorizedRemovals.clear()
}
