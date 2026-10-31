import type { AppState } from '../store/types'
import type { NativeChatComposerDraftOwner } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  nativeChatDraftScopeTabId,
  structuredAgentSessionIdOfDraftScope
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  chatWorkspaceByTabId,
  structuredChatWorkspacesBySessionId
} from './structured-chat-tab-index'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

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
