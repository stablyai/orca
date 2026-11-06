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
import { writeNativeChatComposerDraftJournalBatch } from './native-chat-composer-draft-journal-batch'
import { nextSavedAt, records } from './native-chat-composer-draft-memory'
import { savedForm } from './native-chat-composer-draft-saved-form'
import type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'

function complete(scopeKey: string, key: string, completed: string[]): void {
  const custody = draftCustody.get(scopeKey)
  if (custody) {
    custody.handbacks = custody.handbacks.filter((held) => handbackReceiptKey(held) !== key)
    for (const set of [
      custody.retiring,
      custody.discharged,
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
  completed.push(key)
}

/** Advances every requested retirement of the scope as far as its witnesses allow: the receipts
 *  whose stored metadata now needs a metadata-only removal, and the keys whose retirement
 *  completed, for their observers to hear. */
export function advanceNativeChatDraftRetirements(scopeKey: string): {
  metadata: NativeChatDraftHandbackReceipt[]
  completed: string[]
} {
  const custody = draftCustody.get(scopeKey)
  const metadata: NativeChatDraftHandbackReceipt[] = []
  const completed: string[] = []
  // Before the base is known the input is not yet resolved: nothing can end.
  if (!custody?.retiring.size || custody.pending.length) {
    return { metadata, completed }
  }
  for (const key of Array.from(custody.retiring)) {
    const receipt = custody.handbacks.find((held) => handbackReceiptKey(held) === key)
    if (custody.discharged.has(key)) {
      // A committed record already leaves it out.
      if (!custody.retired.has(key) || !receipt) {
        complete(scopeKey, key, completed)
      }
      continue
    }
    if (!receipt) {
      complete(scopeKey, key, completed)
      continue
    }
    if (custody.committed.has(key)) {
      // (a) Discharge the redundant addition first; the committed record still carries the receipt.
      if (!writeNativeChatComposerDraftJournalBatch({ discharge: [[scopeKey, key]] }).written) {
        continue
      }
      custody.discharged.add(key)
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
      snapshots: new Map([
        [scopeKey, { draft, at: draft?.savedAt ?? nextSavedAt(), discharge: [key] }]
      ])
    })
    if (!witness.snapshots.has(scopeKey)) {
      continue
    }
    custody.retired.add(key)
    complete(scopeKey, key, completed)
    metadata.push(receipt)
  }
  return { metadata, completed }
}
