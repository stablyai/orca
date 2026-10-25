import {
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
import { isAiVaultAgent } from '../../../shared/ai-vault-types'
import { getAgentRowPrimaryText } from '../../../shared/agent-row-primary-text'
import type { ConversationReferenceCreate } from '../../../shared/conversation-reference'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { structuredChatTabById } from './structured-chat-tab-index'
import { structuredAgentSessionOwnerForTab } from '@/runtime/structured-agent-session-owner'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { useAppStore } from '@/store'

/** Whether the row names a conversation a reference could be made from, read without the store. */
export function canReferenceAgentRow(row: DashboardAgentRow): boolean {
  return (
    row.rowSource !== 'subagent' &&
    (row.entry.structuredHostOwned === true ||
      (Boolean(row.entry.providerSession) && isAiVaultAgent(row.agentType)))
  )
}

export function agentRowConversationReference(
  row: DashboardAgentRow,
  title?: string
): ConversationReferenceCreate | null {
  if (row.rowSource === 'subagent') {
    return null
  }
  const state = useAppStore.getState()
  const tab = structuredChatTabById(state.unifiedTabsByWorktree, row.tab.worktreeId, row.tab.id)
  const label = (title || getAgentRowPrimaryText(row.entry) || row.agentType).slice(0, 1024)
  if (tab) {
    const owner = structuredAgentSessionOwnerForTab(state, tab)
    if (!owner) {
      return null
    }
    return {
      source: { kind: 'structured', sessionId: tab.entityId, workspaceId: tab.worktreeId },
      title: label,
      executionHostId: owner
    }
  }
  const provider = row.entry.providerSession
  if (!provider || !isAiVaultAgent(row.agentType)) {
    return null
  }
  const environment = runtimeEnvironmentIdOrLocalUnlessTwin(state, row.tab.worktreeId)
  return {
    source: { kind: 'transcript', agent: row.agentType, sessionId: provider.id },
    title: label,
    executionHostId: environment
      ? toRuntimeExecutionHostId(environment)
      : getConnectionExecutionHostId(row.entry.connectionId)
  }
}
