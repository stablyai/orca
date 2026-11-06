// The record a draft write saves: content as storage keeps it, plus the custody it still owes.

import { isNativeChatKeptPastePath } from './native-chat-image-paste'
import { isNativeChatPastedImagePath } from '../../../../shared/native-chat/native-chat-image-label'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session/agent-session-attachments'
import {
  isNativeChatSetupDraft,
  nextSavedAt,
  records,
  type DraftRecord
} from './native-chat-composer-draft-memory'
import {
  draftCustody,
  finishStoredNativeChatDraft,
  withNativeChatDraftCustody
} from './native-chat-composer-draft-custody'
import {
  hasUnincorporatedNativeChatDraftHandback,
  markNativeChatDraftHandbacksDurable
} from './native-chat-composer-draft-receipt-proof'
import { writeNativeChatComposerDraftJournalBatch } from './native-chat-composer-draft-journal-batch'
import { unavailableNativeChatComposerDraftImage } from './native-chat-composer-draft-restore'
import type {
  NativeChatComposerDraftImage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

/** A local paste in Orca's paste folder: it outlives the run, so a restore can show and send it. */
export function isKeptLocalPaste(image: NativeChatComposerDraftImage): boolean {
  return !image.connectionId && isNativeChatKeptPastePath(image.path)
}

/** Omit launch seeds; retain durable local/server pastes, reduce other pastes to unavailable names, and drop empty records unless a receipt is owed. */
export function savedForm(record: DraftRecord): StoredNativeChatComposerDraft | null {
  const { unsavedText, handbacks, sourcePaths, ...saved } = record
  const images = saved.images.map((image) =>
    isNativeChatPastedImagePath(image.path) &&
    !isKeptLocalPaste(image) &&
    !isAgentSessionAttachmentStorePath(image.path)
      ? unavailableNativeChatComposerDraftImage(image)
      : image
  )
  const text = saved.text === unsavedText ? '' : saved.text
  return finishStoredNativeChatDraft(
    text === '' && images.length === 0 ? null : { ...saved, text, images },
    { handbacks, sourcePaths, owner: saved.owner, savedAt: saved.savedAt }
  )
}

/** What a write of `scopeKey` saves now: its current content and custody. */
export function currentStoredNativeChatComposerDraft(
  scopeKey: string
): StoredNativeChatComposerDraft | null {
  if (isNativeChatSetupDraft(scopeKey)) {
    return null
  }
  const record = withNativeChatDraftCustody(records.get(scopeKey), draftCustody.get(scopeKey))
  return record ? savedForm(record) : null
}

/** The current saved form for a new write; a receipt-only record removes content, so it outdates every earlier copy. */
export function nextStoredNativeChatComposerDraft(
  scopeKey: string
): StoredNativeChatComposerDraft | null {
  const custody = draftCustody.get(scopeKey)
  if (custody && !records.has(scopeKey)) {
    custody.savedAt = nextSavedAt()
  }
  return currentStoredNativeChatComposerDraft(scopeKey)
}

/** Storage refused a draft owing a receipt: the journal's copy of the current draft can still prove it. */
export function journalOwedNativeChatDraftHandbacks(scopeKey: string): void {
  // A scope whose base is unknown is proved by its coalesced identified addition, not a snapshot.
  if (
    !hasUnincorporatedNativeChatDraftHandback(scopeKey) ||
    draftCustody.get(scopeKey)?.pending.length
  ) {
    return
  }
  const draft = currentStoredNativeChatComposerDraft(scopeKey)
  const snapshots = new Map(draft ? [[scopeKey, { draft, at: draft.savedAt }]] : [])
  if (writeNativeChatComposerDraftJournalBatch({ snapshots }).snapshots.has(scopeKey)) {
    markNativeChatDraftHandbacksDurable(scopeKey, draft)
  }
}
