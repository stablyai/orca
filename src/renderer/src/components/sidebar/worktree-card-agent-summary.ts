import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { translate } from '@/i18n/i18n'

export type SummaryAgentGroup = {
  state: AgentDotState
  agents: DashboardAgentRowData[]
}

const SUMMARY_STATE_ORDER: AgentDotState[] = [
  'waiting',
  'blocked',
  // Why: a failed main agent outranks live work; a pending question still comes first.
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  // Why: a user's Stop is not news, but it is not a finish either.
  'interrupted',
  'done',
  // Why: below every reporting state, above true idle — the pane is still held.
  'unverifiable',
  'idle'
]

export function getAgentDotState(agent: DashboardAgentRowData): AgentDotState {
  return agentRowDisplayDotState(agent)
}

export function formatSummaryStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'waiting':
      return translate('worktreeAgentSummary.state.waiting', 'waiting')
    case 'blocked':
      return translate('worktreeAgentSummary.state.blocked', 'blocked')
    case 'interrupted':
      return translate('worktreeAgentSummary.state.interrupted', 'interrupted')
    case 'failed':
      return translate('worktreeAgentSummary.state.failed', 'failed')
    case 'working':
      return translate('worktreeAgentSummary.state.working', 'working')
    case 'monitoring':
      return translate('worktreeAgentSummary.state.monitoring', 'monitoring')
    case 'done':
      return translate('worktreeAgentSummary.state.done', 'done')
    case 'idle':
      return translate('worktreeAgentSummary.state.idle', 'idle')
    case 'unverifiable':
      return translate('worktreeAgentSummary.state.unverifiable', 'not reporting')
    case 'unconfirmed':
      return translate('worktreeAgentSummary.state.unconfirmed', 'unconfirmed')
    case 'permission':
      return translate('worktreeAgentSummary.state.permission', 'needs attention')
  }
}

export function buildSummaryAgentGroups(agents: DashboardAgentRowData[]): SummaryAgentGroup[] {
  const groups = new Map<AgentDotState, DashboardAgentRowData[]>()
  for (const agent of agents) {
    const dotState = getAgentDotState(agent)
    const group = groups.get(dotState)
    if (group) {
      group.push(agent)
    } else {
      groups.set(dotState, [agent])
    }
  }
  return SUMMARY_STATE_ORDER.flatMap((state) => {
    const groupAgents = groups.get(state)
    return groupAgents ? [{ state, agents: groupAgents }] : []
  })
}

export function summarizeAgents(agents: DashboardAgentRowData[], subjectLabel: string): string {
  const groups = buildSummaryAgentGroups(agents)
  if (groups.length === 1) {
    const state = formatSummaryStateLabel(groups[0].state)
    return agents.length === 1
      ? translate('worktreeAgentSummary.singleState', '{{subject}} {{state}}', {
          subject: subjectLabel,
          state
        })
      : translate('worktreeAgentSummary.allSameState', 'All {{subject}} {{state}}', {
          subject: subjectLabel,
          state
        })
  }
  const parts = groups.map((group) =>
    translate('worktreeAgentSummary.stateCount', '{{count}} {{state}}', {
      count: group.agents.length,
      state: formatSummaryStateLabel(group.state)
    })
  )
  return translate('worktreeAgentSummary.mixedStates', '{{subject}}: {{states}}', {
    subject: subjectLabel,
    states: parts.join(', ')
  })
}

export function formatSummaryAgentCount(count: number): string {
  return translate('worktreeAgentSummary.agentCount', '{{count}} agents', {
    count,
    defaultValue_one: '{{count}} agent'
  })
}

export function summarizeAgentIdentities(agents: DashboardAgentRowData[]): string {
  return agents
    .map((agent) => {
      const agentLabel =
        agent.agentType && agent.agentType !== 'unknown'
          ? formatAgentTypeLabel(agent.agentType)
          : translate('worktreeAgentSummary.unknownAgent', 'Agent')
      const stateLabel = formatSummaryStateLabel(getAgentDotState(agent))
      return translate('worktreeAgentSummary.identityState', '{{agent}} {{state}}', {
        agent: agentLabel,
        state: stateLabel
      })
    })
    .join('; ')
}

export function selectSummaryGroupIconAgents(
  agents: DashboardAgentRowData[],
  maxCount: number
): DashboardAgentRowData[] {
  const groups = new Map<string, { agents: DashboardAgentRowData[]; firstIndex: number }>()
  agents.forEach((agent, index) => {
    const key = agent.agentType ?? 'unknown'
    const group = groups.get(key)
    if (group) {
      group.agents.push(agent)
    } else {
      groups.set(key, { agents: [agent], firstIndex: index })
    }
  })
  const sortedGroups = [...groups.values()].sort(
    (a, b) => b.agents.length - a.agents.length || a.firstIndex - b.firstIndex
  )
  const selected: DashboardAgentRowData[] = []
  for (const group of sortedGroups) {
    if (selected.length >= maxCount) {
      break
    }
    selected.push(group.agents[0])
  }
  return selected
}
