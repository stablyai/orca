import type { AgentStatusEntry } from './agent-status-types'

/** Full-output boundaries also consume records produced by the main process. */
export type AgentStatusRows =
  | ReadonlyMap<string, AgentStatusEntry>
  | Readonly<Record<string, AgentStatusEntry>>
export function agentStatusEntries(
  rows: AgentStatusRows | null | undefined
): Iterable<readonly [string, AgentStatusEntry]> {
  if (!rows) {
    return []
  }
  return isAgentStatusMap(rows) ? rows.entries() : Object.entries(rows)
}
export function agentStatusValues(rows: AgentStatusRows | null | undefined): AgentStatusEntry[] {
  return Array.from(agentStatusEntries(rows), ([, entry]) => entry)
}

function isAgentStatusMap(rows: AgentStatusRows): rows is ReadonlyMap<string, AgentStatusEntry> {
  return typeof rows.get === 'function'
}
