import type { AppState } from '../store/types'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  nativeChatDraftScopeTabId,
  structuredAgentSessionIdOfDraftScope
} from '@/components/native-chat/native-chat-composer-draft-store'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

function workspaceOfDraftScope(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  scopeKey: string
): string | null {
  const sessionId = structuredAgentSessionIdOfDraftScope(scopeKey)
  if (sessionId !== null) {
    for (const [workspaceId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
      if (tabs.some((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)) {
        return workspaceId
      }
    }
    return null
  }
  const tabId = nativeChatDraftScopeTabId(scopeKey)
  for (const [workspaceId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return workspaceId
    }
  }
  return null
}

/** The workspace, and the host it runs on, whose open chat a new draft is written in; the same
 *  route a removal of that workspace resolves, so the removal finds the draft. */
export function resolveNativeChatDraftOwner(
  state: AppState,
  scopeKey: string
): NativeChatComposerDraftOwner | undefined {
  const workspaceId = workspaceOfDraftScope(state, scopeKey)
  const executionHostId = workspaceId
    ? resolveWorktreeOperationRoute(state, workspaceId)?.executionHostId
    : null
  return workspaceId && executionHostId ? { workspaceId, executionHostId } : undefined
}
