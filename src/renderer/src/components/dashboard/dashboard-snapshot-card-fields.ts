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

export function boundedDashboardLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

export function boundedDashboardLabelOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedDashboardLabel(value)
}

export function dashboardRowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): string | undefined {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  if (
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  ) {
    return undefined
  }
  return getAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled) ?? undefined
}
