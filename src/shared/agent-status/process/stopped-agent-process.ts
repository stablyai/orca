import type { ProcessTableRow } from '../../process-observation/tables/process-table-snapshot'
import { agentOf } from '../../agent-hook-listener/presence/hook-process-root-evidence'

/** Agents job control stopped on this terminal, outside the foreground group: suspended agents awaiting `fg`. */
export function findStoppedAgents(
  rows: readonly ProcessTableRow[],
  foregroundGroup: number | undefined
): string[] {
  const agents = new Set<string>()
  for (const row of rows) {
    if (row.pgid !== foregroundGroup && /T/.test(row.stat) && !/Z/.test(row.stat)) {
      const agent = agentOf(row.command)
      if (agent) {
        agents.add(agent)
      }
    }
  }
  return [...agents]
}
