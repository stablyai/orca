// An identified hand-back joins the draft once, by its receipt, at the draft's actual base; its
// durability is proved by a concrete commit or journal entry and heard through one subscription.

import { currentDraftScope } from './native-chat-launch-draft-source'
import { nativeChatDraftBaseKnown } from './native-chat-composer-draft-base'
import {
  journalNativeChatComposerDraftAddition,
  writeNativeChatComposerDraftJournalBatch
} from './native-chat-composer-draft-journal-batch'
import {
  dirtyScopes,
  isNativeChatMemoryOnlyDraft,
  nextSavedAt,
  notifyDraftAppend,
  records,
  resolveNativeChatComposerDraftOwner
} from './native-chat-composer-draft-memory'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'
import {
  flushNativeChatComposerDrafts,
  hasPendingNativeChatComposerDraftWrite,
  wakeNativeChatDraftRetirements
} from './native-chat-composer-draft-commit'
import {
  draftCustody,
  handbackReceiptKey,
  hasHandbackReceipt,
  pruneNativeChatDraftSourcePaths,
  scopeCustody,
  withHandbackReceipts,
  withIdentifiedHandback,
  type NativeChatDraftHandbackContribution
} from './native-chat-composer-draft-custody'
import {
  nativeChatDraftReceiptProgressOf,
  type NativeChatDraftReceiptProgress
} from './native-chat-composer-draft-receipt-proof'
import {
  addNativeChatDraftReceiptListener,
  deliverNativeChatDraftReceiptCompletion,
  setNativeChatDraftReceiptReconciler
} from './native-chat-composer-draft-receipt-events'
import {
  hydrateNativeChatComposerDrafts,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type {
  NativeChatComposerDraftOwner,
  NativeChatDraftHandbackReceipt
} from './native-chat-composer-draft-storage'

export type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'
export type { NativeChatDraftHandbackContribution } from './native-chat-composer-draft-custody'
export type { NativeChatDraftReceiptProgress } from './native-chat-composer-draft-receipt-proof'

/** One synchronous visible transition once the scope's base is known: merge the complete input as
 *  an independent contribution unless the draft already holds this receipt. Before that, the input
 *  waits as one identified operation and joins at the scope's own base read. */
export function adoptIdentifiedNativeChatDraftInput(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt,
  contribution: NativeChatDraftHandbackContribution,
  sourcePaths: readonly string[],
  owner?: NativeChatComposerDraftOwner
): { adopted: boolean } {
  const scopeKey = currentDraftScope(reference)
  const key = handbackReceiptKey(receipt)
  const held = draftCustody.get(scopeKey)
  if (hasHandbackReceipt(held?.handbacks, receipt) || held?.retired.has(key)) {
    return { adopted: false }
  }
  const before = records.get(scopeKey)
  const custody = scopeCustody(scopeKey, 0)
  custody.handbacks = withHandbackReceipts(custody.handbacks, [receipt])
  custody.sourcePaths = [...new Set([...custody.sourcePaths, ...sourcePaths])]
  custody.added.add(key)
  custody.owner ??= owner ?? before?.owner ?? resolveNativeChatComposerDraftOwner(scopeKey)
  custody.savedAt = nextSavedAt()
  const handback = { receipt, contribution, sourcePaths }
  const journaled =
    !isNativeChatMemoryOnlyDraft(scopeKey) &&
    journalNativeChatComposerDraftAddition(scopeKey, contribution, custody.savedAt, {
      handback: receipt,
      sourcePaths: [...sourcePaths]
    })
  if (journaled) {
    custody.durable.add(key)
  }
  if (!nativeChatDraftBaseKnown(scopeKey)) {
    // Whether this input was already adopted is unknown until the scope's base is read.
    custody.pending.push(handback)
    void hydrateNativeChatComposerDrafts()
    persistNativeChatComposerDraft(scopeKey, 'immediate')
    return { adopted: true }
  }
  if (journaled) {
    custody.journaled.add(key)
  }
  const current = before ?? { text: '', images: [], savedAt: 0 }
  const merged = withIdentifiedHandback({ ...current, handbacks: [] }, handback)
  updateNativeChatComposerDraft(
    scopeKey,
    {
      text: merged.text,
      images: merged.images,
      document: merged.document,
      pastedTextFiles: merged.pastedTextFiles,
      ...(owner ? { owner } : {})
    },
    'immediate'
  )
  if (records.get(scopeKey) === before) {
    // Nothing visible changed, but the receipt itself is owed a write.
    pruneNativeChatDraftSourcePaths(scopeKey, before)
    if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate')
    }
  }
  if (merged.text !== current.text) {
    notifyDraftAppend(scopeKey, contribution, current)
  }
  return { adopted: true }
}

export function nativeChatDraftHasReceipt(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): boolean {
  return hasHandbackReceipt(draftCustody.get(currentDraftScope(reference))?.handbacks, receipt)
}

/** The receipt's three witnesses: backed by a durable copy; incorporated once the draft's base is
 *  resolved and the current draft holding it is saved; retired once no replay can return it. */
export function nativeChatDraftReceiptProgress(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): NativeChatDraftReceiptProgress {
  return nativeChatDraftReceiptProgressOf(currentDraftScope(reference), receipt)
}

/** A Retry's wake for the destination: one commit attempt of the current draft when its receipt is
 *  not yet incorporated or a refused write is still owed, and no write is already on its way. */
export function requestNativeChatDraftReceiptCommit(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const scopeKey = currentDraftScope(reference)
  if (
    nativeChatDraftHasReceipt(scopeKey, receipt) &&
    (!nativeChatDraftReceiptProgress(scopeKey, receipt).incorporated ||
      dirtyScopes.has(scopeKey)) &&
    !hasPendingNativeChatComposerDraftWrite(scopeKey)
  ) {
    dirtyScopes.add(scopeKey)
    flushNativeChatComposerDrafts()
  }
}

/** One removable observer of the receipt's progress through every transition (and refusal), until
 *  removed; it follows the draft through moves. Registration rechecks in this same tick and asks
 *  for one commit attempt when the receipt is not yet incorporated. */
export function subscribeNativeChatDraftReceiptProgress(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt,
  listener: (progress: NativeChatDraftReceiptProgress) => void
): () => void {
  const scopeKey = currentDraftScope(reference)
  let active = true
  const remove = addNativeChatDraftReceiptListener(scopeKey, receipt, (progress) => {
    if (active) {
      listener(progress)
    }
  })
  queueMicrotask(() => {
    if (active) {
      listener(nativeChatDraftReceiptProgress(scopeKey, receipt))
    }
  })
  requestNativeChatDraftReceiptCommit(scopeKey, receipt)
  return () => {
    active = false
    remove()
  }
}

/** Requested only once the source is durably dead and its emitters revoked. The store ends the
 *  receipt only when no replay can return the input, and delivers that completion to the
 *  receipt's observers. */
export function retireNativeChatDraftReceipt(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const scopeKey = currentDraftScope(reference)
  const custody = draftCustody.get(scopeKey)
  const key = handbackReceiptKey(receipt)
  if (!custody || !hasHandbackReceipt(custody.handbacks, receipt)) {
    // The draft's known base no longer holds it; once no journal copy can replay it, it is done.
    if (
      nativeChatDraftBaseKnown(scopeKey) &&
      writeNativeChatComposerDraftJournalBatch({ discharge: [[scopeKey, key]] }).written
    ) {
      deliverNativeChatDraftReceiptCompletion(scopeKey, key)
    }
    return
  }
  custody.retiring.add(key)
  wakeNativeChatDraftRetirements(scopeKey, false)
}

/** The source obligation's reconciler: called for receipts found at load, replay, another
 *  window's write or a move, and at registration for the receipts already known here. */
export function registerNativeChatDraftReceiptReconciler(
  reconciler: (scope: string, receipt: NativeChatDraftHandbackReceipt) => void
): void {
  setNativeChatDraftReceiptReconciler(reconciler)
}

/** Client paths the draft still names and must prepare before a Send. */
export function nativeChatDraftSourcePaths(reference: string): readonly string[] {
  return draftCustody.get(currentDraftScope(reference))?.sourcePaths ?? []
}
