import {
  nativeChatDraftScopeTabId,
  structuredAgentSessionIdOfDraftScope
} from '@/components/native-chat/drafts/native-chat-draft-scope'
import {
  chatWorkspaceByTabId,
  structuredChatWorkspacesBySessionId
} from '../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import { resolveWorktreeOperationRoute } from '../../../lib/workspace/ownership/worktree-operation-route'
import type { AppState } from '../../../store/types'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'

function workspaceOfDraftScope(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  scopeKey: string
): string | null {
  const sessionId = structuredAgentSessionIdOfDraftScope(scopeKey)
  return sessionId !== null
    ? (structuredChatWorkspacesBySessionId(state.unifiedTabsByWorktree, sessionId)[0] ?? null)
    : chatWorkspaceByTabId(state.tabsByWorktree, nativeChatDraftScopeTabId(scopeKey))
}

/** Resolve the same workspace/host route for draft creation and removal so teardown finds the draft. */
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
