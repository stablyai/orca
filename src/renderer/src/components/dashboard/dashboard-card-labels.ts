import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveAgentRowPaneLiveTitle } from './agent-row-pane-live-title'
import type { DashboardAgentRow } from './useDashboardData'

export function rowTask(row: DashboardAgentRow): string {
  return (row.entry.orchestration?.taskTitle ?? '').trim() || (row.entry.prompt ?? '').trim()
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

/** Mirrors useAgentRowConversationName so the board and the sidebar label the
 *  same agent with the same name. */
export function rowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean,
  layout: TerminalLayoutSnapshot | undefined,
  paneTitles: Record<number, string> | undefined
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
  const paneLiveTitle = resolveAgentRowPaneLiveTitle(
    layout,
    paneTitles,
    parsePaneKey(row.paneKey)?.leafId
  )
  return (
    getAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled, paneLiveTitle) ??
    undefined
  )
}
