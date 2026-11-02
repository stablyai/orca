import { useAppStore } from '@/store'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { isAiVaultAgent, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import type { AiVaultPanelWorkspace } from './ai-vault-panel-workspace'

export type AgentSessionHistoryModalRequest = {
  workspace: AiVaultPanelWorkspace
  /** The chat `/resume` was typed in, which a picked conversation replaces. */
  chatTabId: string
  initialQuery: string
  /** The chat's agent, which the panel's agent filter starts on. */
  agent?: AiVaultAgent
}

export function openAgentSessionHistoryModal(request: AgentSessionHistoryModalRequest): void {
  useAppStore.getState().openModal('agent-session-history', {
    worktreeId: request.workspace.worktreeId,
    executionHostId: request.workspace.executionHostId,
    chatTabId: request.chatTabId,
    initialQuery: request.initialQuery,
    agent: request.agent
  })
}

export function readAgentSessionHistoryModalRequest(
  data: Record<string, unknown>
): AgentSessionHistoryModalRequest | null {
  if (typeof data.worktreeId !== 'string' || typeof data.chatTabId !== 'string') {
    return null
  }
  const executionHostId =
    typeof data.executionHostId === 'string' ? normalizeExecutionHostId(data.executionHostId) : null
  return {
    workspace: {
      worktreeId: data.worktreeId,
      ...(executionHostId ? { executionHostId } : {})
    },
    chatTabId: data.chatTabId,
    initialQuery: typeof data.initialQuery === 'string' ? data.initialQuery : '',
    ...(isAiVaultAgent(data.agent) ? { agent: data.agent } : {})
  }
}
