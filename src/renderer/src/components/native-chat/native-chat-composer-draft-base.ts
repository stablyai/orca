// What a draft write saves, decided against the scope's actual stored base inside its transaction.

import { withIndependentNativeChatComposerDraft } from './native-chat-composer-draft-addition'
import {
  claimUncommittedNativeChatDraftHandbacks,
  draftCustody,
  handbackReceiptKey,
  knownDraftBases,
  projectStoredNativeChatDraftCustody,
  referencedNativeChatDraftPaths,
  withIdentifiedHandback
} from './native-chat-composer-draft-custody'
import {
  replayNativeChatComposerDraftJournal,
  snapshotNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  isNativeChatSetupDraft,
  load,
  nextSavedAt,
  notifyScope,
  records
} from './native-chat-composer-draft-memory'
import { noticeNativeChatDraftReceipts } from './native-chat-composer-draft-receipt-events'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
import { currentStoredNativeChatComposerDraft } from './native-chat-composer-draft-saved-form'
import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

/** Composes the scope's pending hand-backs, and what was typed into its partial view, onto its
 *  actual base, then shows that complete draft; later edits are ordinary complete edits. */
export function establishNativeChatDraftBase(
  scopeKey: string,
  base: StoredNativeChatComposerDraft | null,
  materialized: readonly string[] = [],
  /** What storage itself holds, before any journal replay. */
  committed: StoredNativeChatComposerDraft | null | undefined = base
): void {
  const custody = draftCustody.get(scopeKey)
  const partial = records.get(scopeKey)
  let draft: StoredNativeChatComposerDraft = base ?? {
    text: '',
    images: [],
    savedAt: 0,
    ...(custody?.owner ? { owner: custody.owner } : {})
  }
  // What was typed before the base was known is independent of it, never a replacement.
  if (partial && (partial.text !== '' || partial.images.length > 0)) {
    draft = { ...draft, ...withIndependentNativeChatComposerDraft(draft, partial) }
  }
  for (const handback of custody?.pending ?? []) {
    const key = handbackReceiptKey(handback.receipt)
    draft = withIdentifiedHandback(draft, handback, custody?.retired.has(key))
    custody?.journaled.add(key)
  }
  if (custody) {
    custody.pending = []
  }
  knownDraftBases.add(scopeKey)
  installStoredNativeChatComposerDraft(
    scopeKey,
    { ...draft, savedAt: nextSavedAt() },
    base?.handbacks ?? []
  )
  materialized.forEach((key) => draftCustody.get(scopeKey)?.journaled.add(key))
  claimUncommittedNativeChatDraftHandbacks(scopeKey, committed)
  noticeNativeChatDraftReceipts(scopeKey)
  notifyScope(scopeKey)
}

/** The record a write saves, given what the transaction read: an unknown base is established
 *  first; otherwise memory's content with the stored receipts it never saw and none it retired. */
export function nativeChatDraftAtBase(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft | null
): StoredNativeChatComposerDraft | null {
  if (isNativeChatSetupDraft(scopeKey)) {
    return null
  }
  const custody = draftCustody.get(scopeKey)
  if (custody?.pending.length && !knownDraftBases.has(scopeKey)) {
    const drafts = new Map([[scopeKey, stored]])
    const materialized = new Map<string, Set<string>>()
    if (!load.complete) {
      const entries = snapshotNativeChatComposerDraftJournal().filter(
        (entry) => entry.scopeKey === scopeKey
      )
      replayNativeChatComposerDraftJournal(drafts, entries, materialized)
    }
    establishNativeChatDraftBase(
      scopeKey,
      drafts.get(scopeKey) ?? null,
      [...(materialized.get(scopeKey) ?? [])],
      stored
    )
  } else {
    const before = new Set(custody?.handbacks.map(handbackReceiptKey))
    projectStoredNativeChatDraftCustody(scopeKey, stored, stored?.handbacks ?? [])
    const learned = (draftCustody.get(scopeKey)?.handbacks ?? []).filter(
      (receipt) => !before.has(handbackReceiptKey(receipt))
    )
    if (learned.length) {
      noticeNativeChatDraftReceipts(scopeKey, learned)
    }
    if (!load.complete && !load.appendsBeforeLoad.has(scopeKey)) {
      // Storage now holds exactly this memory: a load that read the older record must not replace it.
      knownDraftBases.add(scopeKey)
    }
  }
  const result = currentStoredNativeChatComposerDraft(scopeKey)
  // Provenance the stored record holds for paths this content still names is kept too.
  const referenced = referencedNativeChatDraftPaths(result ?? undefined)
  const kept = (stored?.sourcePaths ?? []).filter(
    (path) => referenced.has(path) && !result?.sourcePaths?.includes(path)
  )
  return result && kept.length
    ? { ...result, sourcePaths: [...(result.sourcePaths ?? []), ...kept] }
    : result
}
