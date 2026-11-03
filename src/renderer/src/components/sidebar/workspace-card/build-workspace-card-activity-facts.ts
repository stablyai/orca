import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { CARD_TEMPLATE_LIMITS } from '../../../../../shared/workspace-cards/card-template-schema'
import type {
  WorkspaceCardAgentFacts,
  WorkspaceCardFacts
} from '../../../../../shared/workspace-cards/workspace-card-facts'

type ActivityFacts = WorkspaceCardFacts['activity']

export const NO_ACTIVITY_FACTS: ActivityFacts = {
  status: 'inactive',
  needsInput: false,
  counts: { working: 0, blocked: 0, done: 0, idle: 0 },
  agents: []
}

function agentState(row: DashboardAgentRow): WorkspaceCardAgentFacts['state'] {
  switch (row.state) {
    case 'working':
      return 'working'
    case 'blocked':
    case 'waiting':
      return 'blocked'
    case 'done':
      return 'done'
    case 'idle':
    case 'unverifiable':
      return 'idle'
  }
}

function agentMessage(row: DashboardAgentRow): string {
  const { entry } = row
  return entry.lastAssistantMessage && !entry.lastAssistantMessageIsToolOutput
    ? entry.lastAssistantMessage
    : entry.prompt
}

const activityCache = new WeakMap<readonly DashboardAgentRow[], Map<string, ActivityFacts>>()

/** The workspace's agents as facts; one object per rows array and status, so cards that read
 *  agents re-render only when their own rows change. */
export function buildWorkspaceCardActivityFacts(
  rows: readonly DashboardAgentRow[],
  status: string
): ActivityFacts {
  let byStatus = activityCache.get(rows)
  if (!byStatus) {
    byStatus = new Map()
    activityCache.set(rows, byStatus)
  }
  const cached = byStatus.get(status)
  if (cached) {
    return cached
  }
  const agents = rows
    .map((row) => ({
      title: row.tab.customTitle || row.tab.title || row.agentType,
      agent: row.agentType,
      state: agentState(row),
      message: agentMessage(row),
      since: row.entry.stateStartedAt
    }))
    .sort((left, right) => right.since - left.since)
    .slice(0, CARD_TEMPLATE_LIMITS.maxEachItems)
  const counts = { working: 0, blocked: 0, done: 0, idle: 0 }
  for (const agent of agents) {
    if (agent.state === 'working') {
      counts.working++
    } else if (agent.state === 'blocked') {
      counts.blocked++
    } else if (agent.state === 'done') {
      counts.done++
    } else {
      counts.idle++
    }
  }
  const facts: ActivityFacts = {
    status,
    needsInput: status === 'permission',
    counts,
    agents
  }
  byStatus.set(status, facts)
  return facts
}
