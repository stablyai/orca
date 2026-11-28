import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { deleteNativeChatComposerDraft } from './native-chat-composer-draft-removal'
import {
  deferredRemovals,
  installNativeChatDraftRecord,
  load,
  nextSavedAt,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
import { moveNativeChatPendingAttachments } from '../attachments/chips/native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from '../paste/native-chat-pasted-text-reference'
import {
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft
} from './native-chat-draft-attachment-staging'
import {
  nativeChatComposerDraftWriteSettled,
  persistNativeChatComposerDraft
} from './native-chat-composer-draft-persistence'
import {
  PENDING_CREATION_DRAFT_SCOPE_PREFIX,
  structuredAgentSessionDraftScopeKey
} from './native-chat-draft-scope'
import { hydrateNativeChatComposerDrafts } from './native-chat-composer-draft-load'

/** Commit the accepted tab's address with the source before the live move can be interrupted. */
export async function preparePendingChatDraftHandoff(
  sourceScope: string,
  sessionId: string,
  owner: NativeChatComposerDraftOwner
): Promise<void> {
  if (!load.hydrated) {
    await hydrateNativeChatComposerDrafts()
  }
  const source = records.get(sourceScope)
  if (!source) {
    return
  }
  installNativeChatDraftRecord(sourceScope, {
    ...source,
    owner,
    handoffSessionId: sessionId,
    savedAt: nextSavedAt()
  })
  persistNativeChatComposerDraft(sourceScope, 'immediate')
  await nativeChatComposerDraftWriteSettled(sourceScope)
}

export function recoverPendingChatDraftHandoff(sourceScope: string): void {
  const source = records.get(sourceScope)
  if (!source?.handoffSessionId || !source.owner) {
    return
  }
  const destination = structuredAgentSessionDraftScopeKey(source.handoffSessionId)
  const owner = records.get(destination)?.owner
  if (
    owner &&
    (owner.workspaceId !== source.owner.workspaceId ||
      owner.executionHostId !== source.owner.executionHostId)
  ) {
    // This receipt cannot name the chat. Do not let clearing its composer make it eligible later.
    const { handoffSessionId: _conflict, ...unbound } = source
    installNativeChatDraftRecord(sourceScope, { ...unbound, savedAt: nextSavedAt() })
    persistNativeChatComposerDraft(sourceScope, 'immediate')
    return
  }
  moveNativeChatComposerDraft(sourceScope, destination, source.owner, () => ({
    at: 'start',
    pending: true
  }))
}

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
  const handoff = records.get(sourceScope)?.handoffSessionId
  const bound =
    sourceScope.startsWith(PENDING_CREATION_DRAFT_SCOPE_PREFIX) &&
    handoff !== undefined &&
    structuredAgentSessionDraftScopeKey(handoff) === destinationScope
  moveNativeChatStagedFiles(sourceScope, destinationScope)
  moveNativeChatPendingAttachments(sourceScope, destinationScope)
  for (const operation of nativeChatPastedTextOperations.values()) {
    if (operation.scopeKey === sourceScope) {
      operation.scopeKey = destinationScope
    }
  }
  if (source.text !== '' || source.images.length > 0) {
    if (bound) {
      deferredRemovals.set(sourceScope, { destinationScope, savedAt: nextSavedAt(), atomic: true })
    }
    const durable = appendToNativeChatComposerDraft(destinationScope, source, owner, position)
    const destination = records.get(destinationScope)
    if (!bound && !durable && destination) {
      deferredRemovals.set(sourceScope, { destinationScope, savedAt: destination.savedAt })
    }
  }
  reconcileNativeChatStagedDraft(destinationScope, records.get(destinationScope))
  deleteNativeChatComposerDraft(sourceScope)
}
