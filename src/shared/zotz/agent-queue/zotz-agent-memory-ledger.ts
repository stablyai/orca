import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'

/** Peak memory of each agent's recent runs, newest last; persisted in Zotz's userData. */
export type ZotzAgentMemoryLedger = Partial<Record<TuiAgent, number[]>>

const RUNS_KEPT = 20
const ESTIMATE_PERCENTILE = 0.9

export function recordZotzAgentPeak(
  ledger: ZotzAgentMemoryLedger,
  agent: TuiAgent,
  peakBytes: number
): ZotzAgentMemoryLedger {
  if (!Number.isFinite(peakBytes) || peakBytes <= 0) {
    return ledger
  }
  const runs = [...(ledger[agent] ?? []), peakBytes].slice(-RUNS_KEPT)
  return { ...ledger, [agent]: runs }
}

/** p90 of the recorded peaks (nearest rank), so one unusually small run does not under-reserve. */
export function estimateZotzAgentMemory(
  ledger: ZotzAgentMemoryLedger,
  agent: TuiAgent,
  defaultBytes: number
): number {
  const runs = ledger[agent]
  if (!runs || runs.length === 0) {
    return defaultBytes
  }
  const sorted = [...runs].sort((left, right) => left - right)
  const rank = Math.ceil(ESTIMATE_PERCENTILE * sorted.length)
  return sorted[rank - 1]!
}

export function normalizeZotzAgentMemoryLedger(value: unknown): ZotzAgentMemoryLedger {
  const ledger: ZotzAgentMemoryLedger = {}
  if (typeof value !== 'object' || value === null) {
    return ledger
  }
  for (const [agent, runs] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !Array.isArray(runs)) {
      continue
    }
    const peaks = runs.filter(
      (run): run is number => typeof run === 'number' && Number.isFinite(run) && run > 0
    )
    if (peaks.length > 0) {
      ledger[agent] = peaks.slice(-RUNS_KEPT)
    }
  }
  return ledger
}
