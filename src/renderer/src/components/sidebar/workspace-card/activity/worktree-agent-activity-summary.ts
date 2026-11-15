import type { AppState } from '@/store/types'
import type { VisibleOrchestrationState } from '@/runtime/agent-orchestration/visible-agent-orchestration'
export type WorktreeAgentActivitySummary = {
  revision?: number
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  /** A fresh failed main agent, also while its subagents run; kept apart from clean done. */
  hasFailed: boolean
  /** Fresh interrupted completion, kept separate from clean done outcomes. */
  hasInterrupted: boolean
  /** A fresh end Orca cannot prove, likewise never a clean done. */
  hasUnconfirmed: boolean
  hasLiveDone: boolean
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
  /** Stale rows suppress generated permission labels while preserving native title fallback. */
  stalePaneIdsByTabId: Record<string, ReadonlySet<string>>
}

type AgentActivityTabsByWorktree = Record<string, readonly { id: string }[]>

export type AgentActivityInput = Pick<
  AppState,
  'agentStatusEpoch' | 'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId'
> &
  VisibleOrchestrationState & {
    tabsByWorktree: AgentActivityTabsByWorktree
    runtimeAgentOrchestrationByPaneKey?: AppState['runtimeAgentOrchestrationByPaneKey']
  }

export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  return state.agentStatusByPaneKey.projection.summary(worktreeId)
}
