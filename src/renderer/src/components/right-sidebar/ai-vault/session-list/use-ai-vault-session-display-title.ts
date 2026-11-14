import { structuredChatDisplayName } from '../../../../../../shared/structured-chat-row-name'
import { useAppStore } from '@/store/index'
import { structuredChatTabBySessionId } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { useStructuredChatNaming } from '@/runtime/native-chat/naming/structured-conversation-name'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultOriginalPaneTarget } from '../session-actions/ai-vault-original-pane'

/** Terminal rows show their open tab's rename; native rows use live saved names, falling back to authoritative host titles across closed tabs and restarts. */
export function useAiVaultSessionDisplayTitle(
  session: AiVaultSession,
  originalPane?: AiVaultOriginalPaneTarget | null
): { title: string; forked: boolean } {
  const owner = session.structuredSession
  const customLabel = useAppStore((state) => {
    const tab = owner
      ? structuredChatTabBySessionId(
          state.unifiedTabsByWorktree,
          owner.workspaceId,
          owner.sessionId
        )
      : undefined
    return tab?.agentSessionAgent === session.agent &&
      (tab.executionHostId ?? 'local') === session.executionHostId
      ? tab.customLabel
      : undefined
  })
  const terminalTabTitle = useAppStore((state) =>
    // Why: the pane matcher is host-blind, and unknown worktrees must not default to local.
    !owner &&
    originalPane &&
    getKnownExecutionHostIdForWorktree(state, originalPane.worktreeId) === session.executionHostId
      ? state.tabsByWorktree[originalPane.worktreeId]
          ?.find((tab) => tab.id === originalPane.tabId)
          ?.customTitle?.trim()
      : undefined
  )
  const naming = useStructuredChatNaming(session.executionHostId, owner?.sessionId)
  // A forked chat's row draws the fork mark before its title.
  return owner
    ? {
        title: structuredChatDisplayName(customLabel, naming.name, session.title),
        forked: naming.forkSourceId !== null
      }
    : { title: terminalTabTitle || session.title, forked: false }
}
