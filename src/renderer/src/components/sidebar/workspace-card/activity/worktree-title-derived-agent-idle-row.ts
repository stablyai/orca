import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

export function buildTitleDerivedIdleAgentRow(args: {
  paneKey: string
  tab: TerminalTab
  title: string
  launchAgent: AgentType
  now: number
  authorityId: string
  orchestration?: AgentStatusOrchestrationContext
}): DashboardAgentRow {
  const rowLabel = formatAgentTypeLabel(args.launchAgent)
  // Why: title-only rows are renderer snapshots, not provider hook transitions.
  const entry: AgentStatusEntry = {
    paneKey: args.paneKey,
    state: 'working',
    prompt: rowLabel,
    updatedAt: args.now,
    stateStartedAt: args.now,
    stateHistory: [],
    agentType: args.launchAgent,
    terminalTitle: args.title,
    lastAssistantMessage: 'Idle',
    ...(args.orchestration ? { orchestration: args.orchestration } : {}),
    observation: {
      origin: 'title',
      authorityId: args.authorityId,
      incarnation: 0,
      revision: args.now,
      observedAt: args.now,
      kind: 'snapshot'
    }
  }
  return {
    paneKey: args.paneKey,
    entry,
    tab: args.tab,
    agentType: args.launchAgent,
    rowSource: 'live',
    state: 'idle',
    startedAt: 0
  }
}
