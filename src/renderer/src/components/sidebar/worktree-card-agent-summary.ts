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
  // Failures outrank live work, but pending questions come first.
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  // A user stop is neither new work nor clean completion.
  'interrupted',
  'done',
  // A held but silent pane ranks above idle and below every reporting state.
  'unverifiable',
  'idle'
]

export function getAgentDotState(agent: DashboardAgentRowData): AgentDotState {
  return agentRowDisplayDotState(agent)
}

export function formatSummaryStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'waiting':
      return translate('sidebar.agentSummary.state.waiting', 'waiting')
    case 'blocked':
      return translate('sidebar.agentSummary.state.blocked', 'blocked')
    case 'interrupted':
      return translate('sidebar.agentSummary.state.interrupted', 'interrupted')
    case 'failed':
      return translate('sidebar.agentSummary.state.failed', 'failed')
    case 'working':
      return translate('sidebar.agentSummary.state.working', 'working')
    case 'monitoring':
      return translate('sidebar.agentSummary.state.monitoring', 'monitoring')
    case 'done':
      return translate('sidebar.agentSummary.state.done', 'done')
    case 'idle':
      return translate('sidebar.agentSummary.state.idle', 'idle')
    case 'unverifiable':
      return translate('sidebar.agentSummary.state.notReporting', 'not reporting')
    case 'unconfirmed':
      return translate('sidebar.agentSummary.state.unconfirmed', 'unconfirmed')
    case 'permission':
      return translate('sidebar.agentSummary.state.needsAttention', 'needs attention')
  }
}

// Per-state plural keys let locales inflect the status word for its count.
function formatStateCount(state: AgentDotState, count: number): string {
  switch (state) {
    case 'waiting':
      return translate('sidebar.agentSummary.stateCount.waiting', '{{count}} waiting', {
        count,
        defaultValue_one: '{{count}} waiting'
      })
    case 'blocked':
      return translate('sidebar.agentSummary.stateCount.blocked', '{{count}} blocked', {
        count,
        defaultValue_one: '{{count}} blocked'
      })
    case 'interrupted':
      return translate('sidebar.agentSummary.stateCount.interrupted', '{{count}} interrupted', {
        count,
        defaultValue_one: '{{count}} interrupted'
      })
    case 'failed':
      return translate('sidebar.agentSummary.stateCount.failed', '{{count}} failed', {
        count,
        defaultValue_one: '{{count}} failed'
      })
    case 'working':
      return translate('sidebar.agentSummary.stateCount.working', '{{count}} working', {
        count,
        defaultValue_one: '{{count}} working'
      })
    case 'monitoring':
      return translate('sidebar.agentSummary.stateCount.monitoring', '{{count}} monitoring', {
        count,
        defaultValue_one: '{{count}} monitoring'
      })
    case 'done':
      return translate('sidebar.agentSummary.stateCount.done', '{{count}} done', {
        count,
        defaultValue_one: '{{count}} done'
      })
    case 'idle':
      return translate('sidebar.agentSummary.stateCount.idle', '{{count}} idle', {
        count,
        defaultValue_one: '{{count}} idle'
      })
    case 'unverifiable':
      return translate('sidebar.agentSummary.stateCount.notReporting', '{{count}} not reporting', {
        count,
        defaultValue_one: '{{count}} not reporting'
      })
    case 'unconfirmed':
      return translate('sidebar.agentSummary.stateCount.unconfirmed', '{{count}} unconfirmed', {
        count,
        defaultValue_one: '{{count}} unconfirmed'
      })
    case 'permission':
      return translate(
        'sidebar.agentSummary.stateCount.needsAttention',
        '{{count}} needs attention',
        {
          count,
          defaultValue_one: '{{count}} needs attention'
        }
      )
  }
}

// The _one form drops "All" because a lone agent reads "1 agent done".
function formatAllAgentsInState(state: AgentDotState, count: number): string {
  switch (state) {
    case 'waiting':
      return translate('sidebar.agentSummary.allInState.waiting', 'All {{count}} agents waiting', {
        count,
        defaultValue_one: '{{count}} agent waiting'
      })
    case 'blocked':
      return translate('sidebar.agentSummary.allInState.blocked', 'All {{count}} agents blocked', {
        count,
        defaultValue_one: '{{count}} agent blocked'
      })
    case 'interrupted':
      return translate(
        'sidebar.agentSummary.allInState.interrupted',
        'All {{count}} agents interrupted',
        {
          count,
          defaultValue_one: '{{count}} agent interrupted'
        }
      )
    case 'failed':
      return translate('sidebar.agentSummary.allInState.failed', 'All {{count}} agents failed', {
        count,
        defaultValue_one: '{{count}} agent failed'
      })
    case 'working':
      return translate('sidebar.agentSummary.allInState.working', 'All {{count}} agents working', {
        count,
        defaultValue_one: '{{count}} agent working'
      })
    case 'monitoring':
      return translate(
        'sidebar.agentSummary.allInState.monitoring',
        'All {{count}} agents monitoring',
        {
          count,
          defaultValue_one: '{{count}} agent monitoring'
        }
      )
    case 'done':
      return translate('sidebar.agentSummary.allInState.done', 'All {{count}} agents done', {
        count,
        defaultValue_one: '{{count}} agent done'
      })
    case 'idle':
      return translate('sidebar.agentSummary.allInState.idle', 'All {{count}} agents idle', {
        count,
        defaultValue_one: '{{count}} agent idle'
      })
    case 'unverifiable':
      return translate(
        'sidebar.agentSummary.allInState.notReporting',
        'All {{count}} agents not reporting',
        {
          count,
          defaultValue_one: '{{count}} agent not reporting'
        }
      )
    case 'unconfirmed':
      return translate(
        'sidebar.agentSummary.allInState.unconfirmed',
        'All {{count}} agents unconfirmed',
        {
          count,
          defaultValue_one: '{{count}} agent unconfirmed'
        }
      )
    case 'permission':
      return translate(
        'sidebar.agentSummary.allInState.needsAttention',
        'All {{count}} agents needs attention',
        {
          count,
          defaultValue_one: '{{count}} agent needs attention'
        }
      )
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
  const counts = new Map<AgentDotState, number>()
  for (const agent of agents) {
    const dotState = getAgentDotState(agent)
    counts.set(dotState, (counts.get(dotState) ?? 0) + 1)
  }
  const states = SUMMARY_STATE_ORDER.filter((state) => (counts.get(state) ?? 0) > 0)
  if (states.length === 1) {
    return formatAllAgentsInState(states[0], agents.length)
  }
  return translate('sidebar.agentSummary.mixedStates', '{{subject}}: {{states}}', {
    subject: subjectLabel,
    states: states.map((state) => formatStateCount(state, counts.get(state) ?? 0)).join(', ')
  })
}

export function summarizeAgentIdentities(agents: DashboardAgentRowData[]): string {
  return agents
    .map((agent) => {
      const agentLabel = formatAgentTypeLabel(agent.agentType)
      const stateLabel = formatSummaryStateLabel(getAgentDotState(agent))
      return translate('sidebar.agentSummary.agentIdentityState', '{{agent}} {{status}}', {
        agent: agentLabel,
        status: stateLabel
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
