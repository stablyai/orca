import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  deferredRemovals,
  hasLocalChange,
  nextSavedAt,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import { draftCustody, moveNativeChatDraftCustody } from './native-chat-composer-draft-custody'
import { persistNativeChatComposerDraft } from './native-chat-composer-draft-persistence'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import {
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft
} from './native-chat-draft-attachment-staging'

/** Transfer the live draft synchronously; storage acknowledgement only governs source cleanup. */
export function moveNativeChatComposerDraft(
  sourceScope: string,
  destinationScope: string,
  owner?: NativeChatComposerDraftOwner,
  position?: (draft: NativeChatComposerDraft) => NativeChatDraftPosition
): void {
  if (sourceScope === destinationScope) {
    return
  }
  const source = readNativeChatComposerDraft(sourceScope)
  moveNativeChatStagedFiles(sourceScope, destinationScope)
  moveNativeChatPendingAttachments(sourceScope, destinationScope)
  for (const operation of nativeChatPastedTextOperations.values()) {
    if (operation.scopeKey === sourceScope) {
      operation.scopeKey = destinationScope
    }
  }
  // Receipts travel before the content so the destination's next write carries both.
  const receipts = moveNativeChatDraftCustody(sourceScope, destinationScope, nextSavedAt())
  const hasContent = source.text !== '' || source.images.length > 0
  const durable =
    hasContent && appendToNativeChatComposerDraft(destinationScope, source, owner, position)
  if (receipts && !hasLocalChange(destinationScope)) {
    persistNativeChatComposerDraft(destinationScope, 'immediate')
  }
  // Only a destination write holding the moved receipts lets the source record go.
  const savedAt = Math.max(
    records.get(destinationScope)?.savedAt ?? 0,
    draftCustody.get(destinationScope)?.savedAt ?? 0
  )
  if ((hasContent && !durable) || receipts) {
    deferredRemovals.set(sourceScope, { destinationScope, savedAt })
  }
  reconcileNativeChatStagedDraft(destinationScope, records.get(destinationScope))
  deleteNativeChatComposerDraft(sourceScope)
  if (receipts && !hasContent) {
    // Its receipt-only record is still saved; it goes once the destination's write lands.
    persistNativeChatComposerDraft(sourceScope, 'immediate')
  }
}
