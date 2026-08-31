import type { DashboardCardSubagent } from '../../../../shared/dashboard-snapshot'
import { nonEmpty } from './dashboard-card-labels'
import type { DashboardAgentRow } from './useDashboardData'

/** Subagent child rows, grouped under the parent pane whose session spawned
 *  them — they have no pane of their own, so the board nests them on the card. */
export function groupSubagentsByParentPaneKey(
  rows: readonly DashboardAgentRow[]
): Map<string, DashboardCardSubagent[]> {
  const byParentPaneKey = new Map<string, DashboardCardSubagent[]>()
  for (const row of rows) {
    if (row.rowSource !== 'subagent') {
      continue
    }
    const parentPaneKey = row.entry.orchestration?.parentPaneKey
    if (!parentPaneKey) {
      continue
    }
    const subagent: DashboardCardSubagent = {
      id: row.paneKey,
      name:
        nonEmpty(row.entry.orchestration?.displayName) ??
        nonEmpty(row.entry.prompt) ??
        row.agentType,
      dotState: row.state
    }
    const existing = byParentPaneKey.get(parentPaneKey)
    if (existing) {
      existing.push(subagent)
    } else {
      byParentPaneKey.set(parentPaneKey, [subagent])
    }
  }
  return byParentPaneKey
}
