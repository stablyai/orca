// An agent's status joined with the user's acknowledgement of it, read from the store's one record
// (`acknowledgedAgentsByPaneKey`) where a surface builds its rows, so every display of the verdict
// reads the same seen-ness and none can leave it out.

import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentTurnAcknowledgement } from '../../../shared/agent-turn-acknowledgement'

export type AcknowledgedAgentStatusEntry = AgentStatusEntry & AgentTurnAcknowledgement

/** A row whose entry carries its acknowledgement. */
export type AcknowledgedAgentRow = DashboardAgentRow & { entry: AcknowledgedAgentStatusEntry }

// Why: a joined value keeps its identity until its entry or acknowledgement changes, so memoized
// rows and selectors do not re-render on every rebuild.
const joinedEntries = new WeakMap<AgentStatusEntry, AcknowledgedAgentStatusEntry>()
const joinedRows = new WeakMap<DashboardAgentRow, AcknowledgedAgentRow>()

export function acknowledgedAgentEntry(
  entry: AgentStatusEntry,
  acknowledgedAt: number | undefined
): AcknowledgedAgentStatusEntry {
  const cached = joinedEntries.get(entry)
  if (cached && cached.acknowledgedAt === acknowledgedAt) {
    return cached
  }
  const joined = { ...entry, acknowledgedAt }
  joinedEntries.set(entry, joined)
  return joined
}

export function acknowledgedAgentRow(
  row: DashboardAgentRow,
  acknowledgedAt: number | undefined
): AcknowledgedAgentRow {
  const cached = joinedRows.get(row)
  if (cached && cached.entry.acknowledgedAt === acknowledgedAt) {
    return cached
  }
  const joined = { ...row, entry: acknowledgedAgentEntry(row.entry, acknowledgedAt) }
  joinedRows.set(row, joined)
  return joined
}
