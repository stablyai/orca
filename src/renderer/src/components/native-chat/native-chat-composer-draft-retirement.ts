// A receipt's retirement, requested once its source is durably dead. It ends only when no replay
// can return the input again: (a) the committed draft carries the receipt, its identified journal
// addition is discharged, then a committed record leaves the receipt out; or (b) one atomic
// journal write replaces that addition with the complete current draft. A refusal keeps the last
// valid proof; each later commit result, base read or request wakes it again.

import {
  draftCustody,
  dropEmptyNativeChatDraftCustody,
  handbackReceiptKey,
  withNativeChatDraftCustody
} from './native-chat-composer-draft-custody'
import { retiredNativeChatDraftReceipts } from './native-chat-composer-draft-receipt-proof'
import { writeNativeChatComposerDraftJournalBatch } from './native-chat-composer-draft-journal-batch'
import { identifiedJournalId } from './native-chat-composer-draft-journal'
import { nextSavedAt, records } from './native-chat-composer-draft-memory'
import { savedForm } from './native-chat-composer-draft-saved-form'
import type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'

/** Retirements past their discharge, waiting for a committed record without the receipt. */
const awaitingCommit = new Set<string>()

function complete(scopeKey: string, key: string): void {
  const custody = draftCustody.get(scopeKey)
  awaitingCommit.delete(identifiedJournalId(scopeKey, key))
  if (custody) {
    custody.handbacks = custody.handbacks.filter((held) => handbackReceiptKey(held) !== key)
    for (const set of [
      custody.retiring,
      custody.durable,
      custody.incorporated,
      custody.committed,
      custody.added,
      custody.journaled
    ]) {
      set.delete(key)
    }
    dropEmptyNativeChatDraftCustody(scopeKey)
  }
  const retired = retiredNativeChatDraftReceipts.get(scopeKey) ?? new Set<string>()
  retiredNativeChatDraftReceipts.set(scopeKey, retired.add(key))
}

/** Advances every requested retirement of the scope as far as its witnesses allow. Returns the
 *  receipts whose stored metadata now needs a metadata-only removal. */
export function advanceNativeChatDraftRetirements(
  scopeKey: string
): NativeChatDraftHandbackReceipt[] {
  const custody = draftCustody.get(scopeKey)
  // Before the base is known the input is not yet resolved: nothing can end.
  if (!custody?.retiring.size || custody.pending.length) {
    return []
  }
  const metadata: NativeChatDraftHandbackReceipt[] = []
  for (const key of Array.from(custody.retiring)) {
    const id = identifiedJournalId(scopeKey, key)
    const receipt = custody.handbacks.find((held) => handbackReceiptKey(held) === key)
    if (awaitingCommit.has(id)) {
      // A committed record already leaves it out.
      if (!custody.retired.has(key) || !receipt) {
        complete(scopeKey, key)
      }
      continue
    }
    if (!receipt) {
      complete(scopeKey, key)
      continue
    }
    if (custody.committed.has(key)) {
      // (a) Discharge the redundant addition first; the committed record still carries the receipt.
      if (!writeNativeChatComposerDraftJournalBatch({ discharge: [[scopeKey, key]] }).written) {
        continue
      }
      awaitingCommit.add(id)
      custody.retired.add(key)
      metadata.push(receipt)
      continue
    }
    // (b) One atomic replacement of that addition by the complete current draft without it.
    const without = withNativeChatDraftCustody(records.get(scopeKey), {
      ...custody,
      handbacks: custody.handbacks.filter((held) => handbackReceiptKey(held) !== key)
    })
    const draft = without ? savedForm(without) : null
    const witness = writeNativeChatComposerDraftJournalBatch({
      snapshots: new Map([[scopeKey, { draft, at: draft?.savedAt ?? nextSavedAt() }]]),
      discharge: [[scopeKey, key]]
    })
    if (!witness.snapshots.has(scopeKey)) {
      continue
    }
    custody.retired.add(key)
    complete(scopeKey, key)
    metadata.push(receipt)
  }
  return metadata
}

export function resetNativeChatDraftRetirementsForTests(): void {
  awaitingCommit.clear()
  retiredNativeChatDraftReceipts.clear()
}
