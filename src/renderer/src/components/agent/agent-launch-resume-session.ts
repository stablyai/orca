import { createContext, useContext } from 'react'
import { useAppStore } from '@/store/index'
import { openAgentSessionHistoryModal } from '@/components/right-sidebar/ai-vault/panel/agent-session-history-modal'
import { isAiVaultAgent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/** Set by a launch menu that can offer an agent's earlier sessions; menus without it show no Resume. */
export const AgentLaunchResumeSessionContext = createContext<((agent: TuiAgent) => void) | null>(
  null
)

/** Resume for an agent Session History lists, or null where it can't be offered. */
export function useAgentLaunchResumeSession(agent: TuiAgent): (() => void) | null {
  const resume = useContext(AgentLaunchResumeSessionContext)
  return resume && isAiVaultAgent(agent) ? () => resume(agent) : null
}

/** Session History for the workspace, filtered to the agent; a picked row resumes in a new tab. */
export function openAgentLaunchSessionHistory(worktreeId: string, agent: TuiAgent): void {
  const state = useAppStore.getState()
  const executionHostId =
    worktreeId === state.activeWorktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  openAgentSessionHistoryModal({
    workspace: { worktreeId, ...(executionHostId ? { executionHostId } : {}) },
    initialQuery: '',
    ...(isAiVaultAgent(agent) ? { agent } : {})
  })
}
