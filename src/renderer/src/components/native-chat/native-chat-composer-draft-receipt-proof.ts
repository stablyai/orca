// A receipt's proof, derived from concrete results: what storage committed, what the journal
// actually holds, and which retirements completed. Memory's custody is the projection.

import {
  draftCustody,
  dropEmptyNativeChatDraftCustody,
  handbackReceiptKey,
  handbacksAtBase,
  hasHandbackReceipt,
  scopeCustody
} from './native-chat-composer-draft-custody'
import type {
  NativeChatDraftHandbackReceipt,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

/** Memory follows what storage holds: its receipts, less exact local retirements, plus local adoptions. */
export function projectStoredNativeChatDraftCustody(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft | null,
  proven: readonly NativeChatDraftHandbackReceipt[]
): void {
  const custody = scopeCustody(scopeKey, stored?.savedAt ?? 0)
  custody.handbacks = handbacksAtBase(scopeKey, stored)
  custody.owner ??= stored?.owner
  const held = new Set(custody.handbacks.map(handbackReceiptKey))
  proven.forEach((receipt) => custody.durable.add(handbackReceiptKey(receipt)))
  for (const receipt of stored?.handbacks ?? []) {
    const key = handbackReceiptKey(receipt)
    if (held.has(key) && proven.some((held) => handbackReceiptKey(held) === key)) {
      custody.incorporated.add(key)
      custody.committed.add(key)
    }
  }
  for (const set of [custody.durable, custody.incorporated, custody.committed]) {
    for (const key of set) {
      if (!held.has(key)) {
        set.delete(key)
      }
    }
  }
  dropEmptyNativeChatDraftCustody(scopeKey)
}

/** Receipts memory now holds that only the journal carried: the next write at the base adds them. */
export function claimUncommittedNativeChatDraftHandbacks(
  scopeKey: string,
  committed: StoredNativeChatComposerDraft | null | undefined
): void {
  const custody = draftCustody.get(scopeKey)
  for (const receipt of custody?.handbacks ?? []) {
    if (!hasHandbackReceipt(committed?.handbacks, receipt)) {
      custody?.added.add(handbackReceiptKey(receipt))
    }
  }
}

/** A committed record: local adoptions it carries and retirements it omits are settled. */
export function confirmNativeChatDraftCustody(
  scopeKey: string,
  written: StoredNativeChatComposerDraft | null
): void {
  const custody = draftCustody.get(scopeKey)
  if (!custody) {
    return
  }
  const held = new Set((written?.handbacks ?? []).map(handbackReceiptKey))
  for (const key of held) {
    custody.added.delete(key)
    if (custody.handbacks.some((receipt) => handbackReceiptKey(receipt) === key)) {
      custody.durable.add(key)
      custody.incorporated.add(key)
      custody.committed.add(key)
    }
  }
  for (const key of custody.retired) {
    if (!held.has(key)) {
      custody.retired.delete(key)
    }
  }
  dropEmptyNativeChatDraftCustody(scopeKey)
}

/** A written whole journal snapshot of a draft whose base is known backs and incorporates its receipts. */
export function markNativeChatDraftHandbacksDurable(
  scopeKey: string,
  written: StoredNativeChatComposerDraft | null | undefined
): void {
  const custody = draftCustody.get(scopeKey)
  for (const receipt of written?.handbacks ?? []) {
    if (custody && hasHandbackReceipt(custody.handbacks, receipt)) {
      custody.durable.add(handbackReceiptKey(receipt))
      if (!custody.pending.length) {
        custody.incorporated.add(handbackReceiptKey(receipt))
      }
    }
  }
}

export type NativeChatDraftReceiptProgress = {
  /** A durable copy of the returned input exists (witness 1). */
  readonly backed: boolean
  /** Its draft's base is resolved and the current draft holds it, saved (witness 2). */
  readonly incorporated: boolean
  /** Its receipt is gone and no replay can return the input again (witness 4). */
  readonly retired: boolean
}

export function nativeChatDraftReceiptProgressOf(
  scopeKey: string,
  receipt: NativeChatDraftHandbackReceipt
): NativeChatDraftReceiptProgress {
  const key = handbackReceiptKey(receipt)
  // Completion is delivered to the receipt's observers, never kept here.
  const custody = draftCustody.get(scopeKey)
  const held = hasHandbackReceipt(custody?.handbacks, receipt)
  return {
    backed: held && Boolean(custody?.durable.has(key)),
    incorporated: held && Boolean(custody?.incorporated.has(key)) && !custody?.pending.length,
    retired: false
  }
}

export function hasUnincorporatedNativeChatDraftHandback(scopeKey: string): boolean {
  const custody = draftCustody.get(scopeKey)
  return (
    custody?.handbacks.some((receipt) => !custody.incorporated.has(handbackReceiptKey(receipt))) ??
    false
  )
}

/** Only a committed record incorporates a receipt for good; a whole journal snapshot incorporates
 *  it pending that commit; an identified addition replayed into the draft only backs it. */
export function settleLoadedNativeChatDraftProof(
  scopeKey: string,
  committed: StoredNativeChatComposerDraft | null | undefined,
  materialized: readonly string[]
): void {
  const custody = draftCustody.get(scopeKey)
  const inStorage = new Set((committed?.handbacks ?? []).map(handbackReceiptKey))
  for (const receipt of custody?.handbacks ?? []) {
    const key = handbackReceiptKey(receipt)
    if (!inStorage.has(key)) {
      custody?.committed.delete(key)
      if (materialized.includes(key)) {
        custody?.incorporated.delete(key)
      }
    }
  }
}
