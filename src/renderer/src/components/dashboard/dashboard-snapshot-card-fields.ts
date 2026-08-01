import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardBucket
} from '../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { DashboardAgentRow } from './useDashboardData'

export function dashboardBucketForState(state: DashboardAgentRow['state']): DashboardBucket {
  switch (state) {
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    // blocked | waiting — the agent needs the user.
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

export function dashboardRowTask(row: DashboardAgentRow): string {
  return (row.entry.orchestration?.taskTitle ?? '').trim() || (row.entry.prompt ?? '').trim()
}

export function nonEmptyDashboardField(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Why: these labels come from unbounded sources (`terminal rename`, OSC titles,
 *  display names). Over the validator's bound the card would be dropped. */
export function boundedDashboardLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

export function boundedDashboardLabelOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedDashboardLabel(value)
}

/** Mirrors useAgentRowConversationName so the board and the sidebar label the
 *  same agent with the same name. */
export function dashboardRowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): string | undefined {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  // Why: a child row rendered on its parent's tab does not own that tab's name.
  if (
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  ) {
    return undefined
  }
  return getAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled) ?? undefined
}
