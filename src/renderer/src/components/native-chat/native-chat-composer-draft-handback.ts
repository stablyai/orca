// An identified hand-back joins the draft once, by its receipt; its durability is proved, not assumed.

import { currentDraftScope } from './native-chat-launch-draft-source'
import {
  withIndependentNativeChatComposerDraft,
  type NativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import { journalNativeChatComposerDraftAddition } from './native-chat-composer-draft-journal'
import {
  dirtyScopes,
  hasLocalChange,
  isNativeChatMemoryOnlyDraft,
  load,
  nextSavedAt,
  notifyDraftAppend,
  records,
  resolveNativeChatComposerDraftOwner,
  type DraftAppend
} from './native-chat-composer-draft-memory'
import {
  currentStoredNativeChatComposerDraft,
  nativeChatComposerDraftWriteSettled,
  persistNativeChatComposerDraft
} from './native-chat-composer-draft-persistence'
import {
  draftCustody,
  handbackReceiptKey,
  hasHandbackReceipt,
  pruneNativeChatDraftSourcePaths,
  scopeCustody,
  withHandbackReceipts
} from './native-chat-composer-draft-custody'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type {
  NativeChatComposerDraftOwner,
  NativeChatDraftHandbackReceipt
} from './native-chat-composer-draft-storage'

export type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'

export type NativeChatDraftHandbackContribution = Pick<
  NativeChatComposerDraftAddition,
  'text' | 'images' | 'document' | 'pastedTextFiles'
>

/** One synchronous visible transition: merge the complete input as an independent contribution
 *  unless the draft (or, before the load, its stored record) already holds this receipt. Equal
 *  text already in the draft is the user's own and is kept beside it. */
export function adoptIdentifiedNativeChatDraftInput(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt,
  contribution: NativeChatDraftHandbackContribution,
  sourcePaths: readonly string[],
  owner?: NativeChatComposerDraftOwner
): { adopted: boolean } {
  const scopeKey = currentDraftScope(reference)
  if (hasHandbackReceipt(draftCustody.get(scopeKey)?.handbacks, receipt)) {
    return { adopted: false }
  }
  const before = records.get(scopeKey)
  const current = readNativeChatComposerDraft(scopeKey)
  const custody = scopeCustody(scopeKey, 0)
  custody.handbacks = withHandbackReceipts(custody.handbacks, [receipt])
  custody.sourcePaths = [...new Set([...custody.sourcePaths, ...sourcePaths])]
  custody.owned.add(handbackReceiptKey(receipt))
  custody.owner ??= owner ?? before?.owner ?? resolveNativeChatComposerDraftOwner(scopeKey)
  custody.savedAt = nextSavedAt()
  // The stored base decides for a write before the load: its receipt means it already holds the input.
  const append: DraftAppend = (loaded) =>
    hasHandbackReceipt(loaded.handbacks, receipt)
      ? loaded
      : {
          ...loaded,
          ...withIndependentNativeChatComposerDraft(loaded, contribution),
          handbacks: withHandbackReceipts(loaded.handbacks, [receipt]),
          sourcePaths: [...new Set([...(loaded.sourcePaths ?? []), ...sourcePaths])]
        }
  const merged = withIndependentNativeChatComposerDraft(current, contribution)
  updateNativeChatComposerDraft(
    scopeKey,
    { ...merged, ...(owner ? { owner } : {}) },
    'immediate',
    append
  )
  if (records.get(scopeKey) === before) {
    // Nothing visible changed, but the receipt itself is owed a write.
    pruneNativeChatDraftSourcePaths(scopeKey, before)
    if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
      persistNativeChatComposerDraft(scopeKey, 'immediate', append)
    }
  }
  if (merged.text !== current.text) {
    notifyDraftAppend(scopeKey, contribution, current)
  }
  const at = currentStoredNativeChatComposerDraft(scopeKey)?.savedAt ?? custody.savedAt
  if (
    !isNativeChatMemoryOnlyDraft(scopeKey) &&
    journalNativeChatComposerDraftAddition(scopeKey, contribution, at, {
      handback: receipt,
      sourcePaths: [...sourcePaths]
    })
  ) {
    custody.durable.add(handbackReceiptKey(receipt))
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

/** Retry the current draft (later typing, removal or clear included) and settle with its proof. */
export async function whenNativeChatDraftReceiptSettled(
  reference: string,
  receipt: NativeChatDraftHandbackReceipt
): Promise<boolean> {
  const scopeKey = currentDraftScope(reference)
  if (!nativeChatDraftHasReceipt(scopeKey, receipt)) {
    return false
  }
  if (nativeChatDraftReceiptDurable(scopeKey, receipt)) {
    return true
  }
  // Before the load a whole write would replace the stored draft; its pending append is the attempt.
  if (load.hydrated && !hasLocalChange(scopeKey)) {
    dirtyScopes.add(scopeKey)
  }
  await nativeChatComposerDraftWriteSettled(scopeKey)
  return nativeChatDraftReceiptDurable(scopeKey, receipt)
}

/** Only after the source's own retirement is durable and its emitters are revoked. */
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
  custody.owned.delete(key)
  // Kept even when empty so this write's time supersedes every journaled copy holding the receipt.
  custody.savedAt = nextSavedAt()
  if (!isNativeChatMemoryOnlyDraft(scopeKey)) {
    persistNativeChatComposerDraft(scopeKey, 'immediate')
  }
}

/** Client paths the draft still names and must prepare before a Send. */
export function nativeChatDraftSourcePaths(reference: string): readonly string[] {
  return draftCustody.get(currentDraftScope(reference))?.sourcePaths ?? []
}
