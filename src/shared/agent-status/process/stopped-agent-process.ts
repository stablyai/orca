import type { ProcessTableRow } from '../../process-observation/tables/process-table-snapshot'
import { selectForegroundProcessCandidate } from './foreground-process-selection'

/** A job-control-stopped agent on this terminal, outside the foreground group: the suspended agent awaiting `fg`. */
export function findStoppedAgentProcess(
  rows: readonly (ProcessTableRow & { depth?: number })[],
  foregroundGroup: number | undefined
): { pid: number; agent: string } | null {
  const stopped = rows
    .filter((row) => row.pgid !== foregroundGroup && /T/.test(row.stat) && !/Z/.test(row.stat))
    .map((row) => ({ ...row, depth: row.depth ?? 0 }))
  const selected = selectForegroundProcessCandidate(stopped)
  return selected ? { pid: selected.candidate.pid, agent: selected.recognized.agent } : null
}
