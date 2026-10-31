import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  deleteNativeChatComposerDraftsWhere,
  nativeChatDraftScopeTabId,
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope
} from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatLaunchPromptDraftOwner } from '@/components/native-chat/native-chat-composer-draft-memory'
import { dropNativeChatPendingAttachmentsWhere } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'

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

type OwnerMatch = (owner: NativeChatComposerDraftOwner) => boolean

/** One committed event visits each resource family once, including legacy captured keys. */
function deleteMatchingDrafts(
  matchesOwner: OwnerMatch,
  keys?: WorkspaceChatDraftKeys,
  launchOnly = false
): void {
  const conversations = new Set(keys?.conversations)
  const tabs = new Set(keys?.terminalTabIds)
  const matches = (scope: string, owner?: NativeChatComposerDraftOwner): boolean => {
    const launchOwner = nativeChatLaunchPromptDraftOwner(scope)
    const sourceOwner = launchOwner ?? (launchOnly ? undefined : owner)
    return (
      (sourceOwner !== undefined && matchesOwner(sourceOwner)) ||
      conversations.has(scope) ||
      (structuredAgentSessionIdOfDraftScope(scope) === null &&
        tabs.has(nativeChatDraftScopeTabId(scope)))
    )
  }
  deleteNativeChatComposerDraftsWhere((scope, draft) => matches(scope, draft?.owner), true)
  dropNativeChatPendingAttachmentsWhere(matches)
}

function ownerSetMatch(owners: readonly NativeChatComposerDraftOwner[]): OwnerMatch {
  const pairs = new Set(
    owners.map((owner) => JSON.stringify([owner.executionHostId, owner.workspaceId]))
  )
  return (owner) => pairs.has(JSON.stringify([owner.executionHostId, owner.workspaceId]))
}

/** Delete only after success, including chips and pending submissions with no visible record. */
export function deleteWorkspaceChatDraftOwners(keys: WorkspaceChatDraftKeys): void {
  deleteMatchingDrafts(ownerSetMatch(keys.owners))
}

export function deleteWorkspaceChatDrafts(keys: WorkspaceChatDraftKeys): void {
  deleteMatchingDrafts(ownerSetMatch(keys.owners), keys)
}

export function deleteProjectChatDrafts(
  projectId: string,
  executionHostId: ExecutionHostId,
  keys?: WorkspaceChatDraftKeys
): void {
  const captured = ownerSetMatch(keys?.owners ?? [])
  deleteMatchingDrafts(
    (owner) =>
      captured(owner) ||
      (owner.executionHostId === executionHostId &&
        getRepoIdFromWorktreeId(owner.workspaceId) === projectId),
    keys
  )
}

/** Host/catalog removal proves only launch source death, not deletion of ordinary conversations. */
export function deleteLaunchPromptDraftsWhere(matchesOwner: OwnerMatch): void {
  deleteMatchingDrafts(matchesOwner, undefined, true)
}

export function deleteRetiredRuntimeLaunchDrafts(environmentIds: readonly string[]): void {
  if (environmentIds.length === 0) {
    return
  }
  const hosts = new Set(environmentIds.map((id) => `runtime:${id}`))
  deleteLaunchPromptDraftsWhere((owner) => hosts.has(owner.executionHostId))
}

export function workspaceChatDraftFallbacks(keys: WorkspaceChatDraftKeys): WorkspaceChatDraftKeys {
  return { ...keys, owners: [] }
}
