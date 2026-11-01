import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsForTab,
  deleteNativeChatComposerDraftsOwnedBy,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  clearNativeChatPendingAttachments,
  dropNativeChatPendingAttachmentsForTab,
  dropNativeChatPendingAttachmentsOwnedBy
} from '@/components/native-chat/native-chat-pending-attachment-cache'

/** Include owner-tagged open/closed drafts plus tab conversation/pane keys written before owner attribution existed. */
export type WorkspaceChatDraftKeys = {
  readonly owners: readonly NativeChatComposerDraftOwner[]
  readonly conversations: readonly string[]
  readonly terminalTabIds: readonly string[]
}

/** Capture before delete RPC; host announcements may purge tab lists before the reply. */
export function captureWorkspaceChatDraftKeys(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  workspaces: readonly {
    readonly workspaceId: string
    readonly executionHostId: ExecutionHostId | null | undefined
    /** Limits the tab-found keys to these tab/conversation ids, for an id another host also holds. */
    readonly onlyEntityIds?: ReadonlySet<string>
  }[]
): WorkspaceChatDraftKeys {
  const owners: NativeChatComposerDraftOwner[] = []
  const conversations: string[] = []
  const terminalTabIds: string[] = []
  for (const { workspaceId, executionHostId, onlyEntityIds } of workspaces) {
    const included = (entityId: string): boolean => !onlyEntityIds || onlyEntityIds.has(entityId)
    if (executionHostId) {
      owners.push({ workspaceId, executionHostId })
    }
    for (const tab of state.unifiedTabsByWorktree[workspaceId] ?? []) {
      if (tab.contentType === 'agent-session' && included(tab.entityId)) {
        conversations.push(structuredAgentSessionDraftScopeKey(tab.entityId))
      }
    }
    for (const tab of state.tabsByWorktree[workspaceId] ?? []) {
      if (included(tab.id)) {
        terminalTabIds.push(tab.id)
      }
    }
  }
  return { owners, conversations, terminalTabIds }
}

/** Delete only after success, including in-flight upload chips or their later settlement can resurrect drafts. */
export function deleteWorkspaceChatDrafts(keys: WorkspaceChatDraftKeys): void {
  for (const owner of keys.owners) {
    deleteNativeChatComposerDraftsOwnedBy(owner)
    dropNativeChatPendingAttachmentsOwnedBy(owner)
  }
  for (const key of keys.conversations) {
    deleteNativeChatComposerDraft(key)
    clearNativeChatPendingAttachments(key)
  }
  for (const tabId of keys.terminalTabIds) {
    deleteNativeChatComposerDraftsForTab(tabId)
    dropNativeChatPendingAttachmentsForTab(tabId)
  }
}
