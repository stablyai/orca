import {
  resolveAgentRowConversationName,
  type AgentRowConversationNameResolution
} from '../../../../shared/agent-row-conversation-name'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  getAgentRowOrchestrationDisplayName,
  getAgentRowTaskText
} from '@/lib/agent-row-primary-text'
import type { DashboardAgentRow } from './useDashboardData'

export function rowTask(row: DashboardAgentRow): string {
  return getAgentRowTaskText(row.entry)
}

export function rowOrchestrationDisplayName(row: DashboardAgentRow): string | undefined {
  return getAgentRowOrchestrationDisplayName(row.entry)
}

export function rowDashboardIdentity(row: DashboardAgentRow): {
  task: string
  orchestrationDisplayName: string | undefined
} {
  return {
    task: rowTask(row),
    orchestrationDisplayName: boundedLabelOrUndefined(rowOrchestrationDisplayName(row))
  }
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Why: these labels come from unbounded sources (`terminal rename`, OSC titles,
 *  display names). Over the validator's bound the card would be dropped. */
export function boundedLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

export function boundedLabelOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedLabel(value)
}

function rowOwnsConversationName(row: DashboardAgentRow): boolean {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  // Why: a child row rendered on its parent's tab does not own that tab's name.
  return !(
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  )
}

export function rowConversationNameResolution(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): AgentRowConversationNameResolution | undefined {
  if (!rowOwnsConversationName(row)) {
    return undefined
  }
  return (
    resolveAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled) ?? undefined
  )
}

/** Mirrors useAgentRowConversationName so the board and the sidebar label the
 *  same agent with the same name. */
export function rowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): string | undefined {
  return rowConversationNameResolution(row, generatedTitlesEnabled)?.name
}

export function rowDashboardConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): { conversationName?: string; conversationNameExplicit?: boolean } {
  const resolved = rowConversationNameResolution(row, generatedTitlesEnabled)
  return resolved
    ? {
        conversationName: boundedLabel(resolved.name),
        conversationNameExplicit: resolved.explicit
      }
    : { conversationNameExplicit: false }
}
