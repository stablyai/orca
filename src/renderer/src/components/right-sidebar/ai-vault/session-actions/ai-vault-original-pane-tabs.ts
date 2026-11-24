import { agentPaneConversationForEntry } from '@/store/slices/agent-status/conversation/agent-pane-conversation'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  resolveOriginalPaneTarget,
  type AiVaultOriginalPaneTarget,
  type OriginalPaneState
} from './ai-vault-original-pane'

/** Every terminal pane that exactly owns this provider session, across all its tabs. */
export function findAllOriginalAiVaultSessionPaneTabIds(
  state: OriginalPaneState,
  session: AiVaultSession
): string[] {
  const tabIds = new Set<string>()
  const add = (target: AiVaultOriginalPaneTarget | null): void => {
    if (target) {
      tabIds.add(target.tabId)
    }
  }

  for (const entry of Array.from(state.agentStatusByPaneKey.values())) {
    if (entry.agentType === session.agent && entry.providerSession?.id === session.sessionId) {
      add(
        resolveOriginalPaneTarget({
          state,
          paneKey: entry.paneKey,
          worktreeIdHint: entry.worktreeId,
          tabIdHint: entry.tabId
        })
      )
    }
  }

  for (const conversation of Object.values(state.agentConversationsByPaneKey)) {
    if (
      state.agentStatusByPaneKey.get(conversation.paneKey) ||
      conversation.agent !== session.agent ||
      !agentPaneConversationForEntry(state, { ...conversation, agentType: conversation.agent }) ||
      conversation.providerSession?.id !== session.sessionId
    ) {
      continue
    }
    add(
      resolveOriginalPaneTarget({
        state,
        paneKey: conversation.paneKey,
        worktreeIdHint: conversation.worktreeId
      })
    )
  }

  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record.agent === session.agent && record.providerSession?.id === session.sessionId) {
      add(
        resolveOriginalPaneTarget({
          state,
          paneKey: record.paneKey,
          worktreeIdHint: record.worktreeId,
          tabIdHint: record.tabId
        })
      )
    }
  }
  return [...tabIds]
}
