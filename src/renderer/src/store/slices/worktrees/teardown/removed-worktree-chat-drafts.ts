import { retireNativeChatComposerSubmissionsWhere } from '@/components/native-chat/drafts/native-chat-composer-draft-memory'
import {
  nativeChatLaunchPromptDraftOwner,
  launchDraftSource
} from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsForTab,
  deleteNativeChatComposerDraftsOwnedBy
} from '@/components/native-chat/drafts/native-chat-composer-draft-removal'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { clearNativeChatPendingAttachments } from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'
import { retireDeferredNativeChatComposerNoticesWhere } from '@/components/native-chat/composer/controls/native-chat-deferred-composer-notice'
import {
  dropNativeChatPendingAttachmentsForTab,
  dropNativeChatPendingAttachmentsOwnedBy
} from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-drops'

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

/** Committed deletion revokes only the new automatic return writer; saved cleanup remains ordinary. */
/**
 * `additionally` widens only the submission match: a caller's fallback (such as a folder's launch
 * transport origin) may not tell apart two hosts of one same-ID workspace. Paste feedback carries its
 * confirmed workspace and host, so it is retired by exact owner, or by `feedbackAlso`, which must
 * itself judge the confirmed host.
 */
export function deleteWorkspaceChatDraftOwners(
  keys: WorkspaceChatDraftKeys,
  additionally?: (owner: NativeChatComposerDraftOwner, scope: string) => boolean,
  feedbackAlso?: (owner: NativeChatComposerDraftOwner) => boolean
): void {
  const owners = new Set(
    keys.owners.map((owner) => JSON.stringify([owner.executionHostId, owner.workspaceId]))
  )
  const exact = (owner: NativeChatComposerDraftOwner): boolean =>
    owners.has(JSON.stringify([owner.executionHostId, owner.workspaceId]))
  retireNativeChatComposerSubmissionsWhere((scope, draft) => {
    const owner =
      launchDraftSource(scope) ?? nativeChatLaunchPromptDraftOwner(scope) ?? draft?.owner
    return !!owner && (exact(owner) || additionally?.(owner, scope) === true)
  })
  // Also reached when a same-ID survivor skips the full draft sweep, and by project removal: a paste
  // failure kept for a removed workspace's draft goes too, judged by the owner the notice was given.
  retireDeferredNativeChatComposerNoticesWhere(
    (_scope, owner) => !!owner && (exact(owner) || feedbackAlso?.(owner) === true)
  )
}
export function deleteProjectChatDrafts(projectId: string, executionHostId: ExecutionHostId): void {
  const inProject = (owner: NativeChatComposerDraftOwner): boolean =>
    owner.executionHostId === executionHostId &&
    getRepoIdFromWorktreeId(owner.workspaceId) === projectId
  deleteWorkspaceChatDraftOwners(
    { owners: [], conversations: [], terminalTabIds: [] },
    inProject,
    inProject
  )
}
