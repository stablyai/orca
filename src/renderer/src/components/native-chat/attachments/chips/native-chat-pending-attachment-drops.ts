import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'
import {
  nativeChatDraftScopeTabId,
  structuredAgentSessionIdOfDraftScope
} from '../../drafts/native-chat-draft-scope'
import { dropNativeChatPendingAttachmentsWhere } from './native-chat-pending-attachment-cache'

/** Drop only closed-tab pane chips; conversation scopes survive tab closure. */
export function dropNativeChatPendingAttachmentsForTab(tabId: string): void {
  dropNativeChatPendingAttachmentsWhere(
    (scopeKey) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

export function dropNativeChatPendingAttachmentsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  dropNativeChatPendingAttachmentsWhere(
    (_scopeKey, pendingOwner) =>
      pendingOwner?.workspaceId === owner.workspaceId &&
      pendingOwner.executionHostId === owner.executionHostId
  )
}
