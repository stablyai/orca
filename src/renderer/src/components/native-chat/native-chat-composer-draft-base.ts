// What a draft write saves, decided against the scope's actual stored base inside its transaction.

import { withIndependentNativeChatComposerDraft } from './native-chat-composer-draft-addition'
import {
  draftCustody,
  handbackReceiptKey,
  referencedNativeChatDraftPaths,
  withIdentifiedHandback
} from './native-chat-composer-draft-custody'
import {
  claimUncommittedNativeChatDraftHandbacks,
  projectStoredNativeChatDraftCustody,
  settleLoadedNativeChatDraftProof
} from './native-chat-composer-draft-receipt-proof'
import {
  nativeChatComposerDraftReplayEntries,
  replayNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import {
  isNativeChatSetupDraft,
  load,
  nativeChatDraftPositions,
  nextSavedAt,
  type NativeChatDraftPosition,
  notifyScope,
  records
} from './native-chat-composer-draft-memory'
import { noticeNativeChatDraftReceipts } from './native-chat-composer-draft-receipt-events'
import { installStoredNativeChatComposerDraft } from './native-chat-composer-draft-restore'
import { currentStoredNativeChatComposerDraft } from './native-chat-composer-draft-saved-form'
import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { scopeInputs } from './native-chat-composer-draft-input'
export { nativeChatDraftBaseKnown } from './native-chat-composer-draft-input'

/** The scope's own read or write came after the load reading now began: that load's older value
 *  of it must not replace it. Ends with that load. */
function excludeFromNativeChatDraftLoad(scopeKey: string): void {
  load.attempt?.excluded.add(scopeKey)
}

/** Resolves the scope's unresolved input and pending hand-backs at its actual base, once: additions
 *  replay onto it, an edited partial view joins it as independent input, a replacement keeps its
 *  content with the base's receipts. Then shows that complete draft; later edits are complete. */
export function establishNativeChatDraftBase(
  scopeKey: string,
  base: StoredNativeChatComposerDraft | null,
  materialized: readonly string[] = [],
  /** What storage itself holds, before any journal replay. */
  committed: StoredNativeChatComposerDraft | null | undefined = base
): void {
  const custody = draftCustody.get(scopeKey)
  const input = scopeInputs.get(scopeKey)
  const view = records.get(scopeKey)
  const owner = base?.owner ?? view?.owner ?? custody?.owner
  let position: NativeChatDraftPosition | undefined
  let draft: StoredNativeChatComposerDraft = base ?? {
    text: '',
    images: [],
    savedAt: 0,
    ...(owner ? { owner } : {})
  }
  if (input?.kind === 'replaced') {
    const { text = '', images = [], document, pastedTextFiles } = view ?? {}
    const { document: _document, pastedTextFiles: _pasted, ...metadata } = draft
    const held = new Set(draft.images.map((image) => image.id))
    draft = {
      ...metadata,
      text,
      // A text-only consumption leaves the base's attachments where they were.
      images: input.images
        ? images
        : [...draft.images, ...images.filter((image) => !held.has(image.id))],
      ...(document ? { document } : {}),
      ...(pastedTextFiles ? { pastedTextFiles } : {})
    }
  } else if (input?.appends) {
    draft = input.appends.reduce((value, append) => append(value), draft)
    // An addition's own placement in the result it produced.
    position = nativeChatDraftPositions.get(draft)
  } else if (view && (view.text !== '' || view.images.length > 0)) {
    // What was typed before the base was known is independent of it, never a replacement.
    draft = { ...draft, ...withIndependentNativeChatComposerDraft(draft, view) }
  }
  scopeInputs.delete(scopeKey)
  for (const handback of custody?.pending ?? []) {
    const key = handbackReceiptKey(handback.receipt)
    draft = withIdentifiedHandback(draft, handback, custody?.retired.has(key))
    custody?.journaled.add(key)
  }
  if (custody) {
    custody.pending = []
  }
  excludeFromNativeChatDraftLoad(scopeKey)
  installStoredNativeChatComposerDraft(
    scopeKey,
    { ...draft, savedAt: nextSavedAt() },
    base?.handbacks ?? [],
    position
  )
  materialized.forEach((key) => draftCustody.get(scopeKey)?.journaled.add(key))
  claimUncommittedNativeChatDraftHandbacks(scopeKey, committed)
  settleLoadedNativeChatDraftProof(scopeKey, committed, materialized)
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
  if (custody?.pending.length || scopeInputs.has(scopeKey)) {
    const drafts = new Map([[scopeKey, stored]])
    const materialized = new Map<string, Set<string>>()
    if (!load.complete) {
      // This load attempt's one journal snapshot, already indexed by scope.
      replayNativeChatComposerDraftJournal(
        drafts,
        nativeChatComposerDraftReplayEntries(scopeKey),
        materialized
      )
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
    // Storage now holds exactly this memory: a load that read the older record must not replace it.
    excludeFromNativeChatDraftLoad(scopeKey)
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
