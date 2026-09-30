import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type SleepyModeFleetSummary = {
  working: number
  waiting: number
  done: number
}

/** Counts the live fleet the same way the pet reads it: stale rows and monitoring turns don't count as work. */
export function summarizeSleepyModeFleet({
  entries,
  now,
  staleAfterMs
}: {
  entries: AgentStatusEntry[]
  now: number
  staleAfterMs: number
}): SleepyModeFleetSummary {
  const summary: SleepyModeFleetSummary = { working: 0, waiting: 0, done: 0 }

  for (const entry of entries) {
    if (!isExplicitAgentStatusFresh(entry, now, staleAfterMs)) {
      continue
    }
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      summary.waiting += 1
    } else if (entry.state === 'working' && entry.workingMode !== 'monitoring') {
      summary.working += 1
    } else if (entry.state === 'done') {
      summary.done += 1
    }
  }

  return summary
}
