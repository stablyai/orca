// An identified hand-back joins the draft once, by its receipt, at the draft's actual base; its
// durability is proved by a concrete commit or journal entry and heard through one subscription.

import { currentDraftScope } from './native-chat-launch-draft-source'
import { journalNativeChatComposerDraftAddition } from './native-chat-composer-draft-journal'
import {
  dirtyScopes,
  isNativeChatMemoryOnlyDraft,
  load,
  nextSavedAt,
  notifyDraftAppend,
  records,
  resolveNativeChatComposerDraftOwner
} from './native-chat-composer-draft-memory'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'
import {
  flushNativeChatComposerDrafts,
  hasPendingNativeChatComposerDraftWrite,
  retireStoredNativeChatDraftReceipt
} from './native-chat-composer-draft-commit'
import {
  draftCustody,
  handbackReceiptKey,
  hasHandbackReceipt,
  knownDraftBases,
  pruneNativeChatDraftSourcePaths,
  scopeCustody,
  withHandbackReceipts,
  withIdentifiedHandback,
  type NativeChatDraftHandbackContribution
} from './native-chat-composer-draft-custody'
import {
  addNativeChatDraftReceiptListener,
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
  if (!load.complete && !knownDraftBases.has(scopeKey)) {
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

/** True only once a committed draft or a written journal entry holds the receipt; pending is not proof. */
export function nativeChatDraftReceiptDurable(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): boolean {
  const custody = draftCustody.get(currentDraftScope(reference))
  return (
    hasHandbackReceipt(custody?.handbacks, receipt) &&
    Boolean(custody?.durable.has(handbackReceiptKey(receipt)))
  )
}

/** A Retry's wake for the destination: one commit attempt of the current draft when its receipt is
 *  unproved or a refused write is still owed, and no write is already on its way. */
export function requestNativeChatDraftReceiptCommit(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const scopeKey = currentDraftScope(reference)
  if (
    nativeChatDraftHasReceipt(scopeKey, receipt) &&
    (!nativeChatDraftReceiptDurable(scopeKey, receipt) || dirtyScopes.has(scopeKey)) &&
    !hasPendingNativeChatComposerDraftWrite(scopeKey)
  ) {
    dirtyScopes.add(scopeKey)
    flushNativeChatComposerDrafts()
  }
}

/** One removable listener for the receipt's commit results: true once it is durable (in this same
 *  tick when it already is), false for each refused attempt. Registration asks for one attempt. */
export function subscribeNativeChatDraftReceiptCommit(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt,
  listener: (durable: boolean) => void
): () => void {
  const scopeKey = currentDraftScope(reference)
  let active = true
  const remove = addNativeChatDraftReceiptListener(scopeKey, receipt, (durable) => {
    if (active) {
      listener(durable)
    }
  })
  if (nativeChatDraftReceiptDurable(scopeKey, receipt)) {
    queueMicrotask(() => {
      if (active && nativeChatDraftReceiptDurable(scopeKey, receipt)) {
        listener(true)
      }
    })
  } else {
    requestNativeChatDraftReceiptCommit(scopeKey, receipt)
  }
  return () => {
    active = false
    remove()
  }
}

/** Only after the source's own retirement is durable and its emitters are revoked. Changes only the
 *  receipt: the saved record's content, and anything typed here, are left as they are. */
export function retireNativeChatDraftReceipt(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): void {
  const scopeKey = currentDraftScope(reference)
  const custody = draftCustody.get(scopeKey)
  if (!custody || !hasHandbackReceipt(custody.handbacks, receipt)) {
    return
  }
  const key = handbackReceiptKey(receipt)
  custody.handbacks = custody.handbacks.filter((held) => handbackReceiptKey(held) !== key)
  custody.durable.delete(key)
  custody.added.delete(key)
  custody.retired.add(key)
  if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
    retireStoredNativeChatDraftReceipt(scopeKey, receipt)
  }
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
