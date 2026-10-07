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

/** Which unsent chat drafts a workspace owns: every draft that recorded it as its owner, open and
 *  closed chats alike, plus its open tabs' conversation keys and terminal tab ids (each tab's pane
 *  drafts) for drafts written before their owner could be named. */
export type WorkspaceChatDraftKeys = {
  readonly owners: readonly NativeChatComposerDraftOwner[]
  readonly conversations: readonly string[]
  readonly terminalTabIds: readonly string[]
}

/**
 * Read before a user's delete goes to the host: the host announces the removal before it replies,
 * and the listing refresh that starts can drop the tab lists these keys are found through.
 */
export function captureWorkspaceChatDraftKeys(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  workspaces: readonly {
    readonly workspaceId: string
    readonly executionHostId: ExecutionHostId | null | undefined
  }[]
): WorkspaceChatDraftKeys {
  const owners: NativeChatComposerDraftOwner[] = []
  const conversations: string[] = []
  const terminalTabIds: string[] = []
  for (const { workspaceId, executionHostId } of workspaces) {
    if (executionHostId) {
      owners.push({ workspaceId, executionHostId })
    }
    for (const tab of state.unifiedTabsByWorktree[workspaceId] ?? []) {
      if (tab.contentType === 'agent-session') {
        conversations.push(structuredAgentSessionDraftScopeKey(tab.entityId))
      }
    }
    for (const tab of state.tabsByWorktree[workspaceId] ?? []) {
      terminalTabIds.push(tab.id)
    }
  }
  return { owners, conversations, terminalTabIds }
}

/** Only after the delete succeeded: a refused or failed one keeps the drafts. Chips still on their
 *  way go too, or one settling later would write a draft back that nothing could delete. */
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
