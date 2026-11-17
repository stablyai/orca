/** Memory limits for agents, derived once from the machine's RAM (docs/zotz/PLAN.md, Fase 8f). */
export type ZotzMemoryGovernorLimits = {
  /** Ceiling for the memory all live agents may hold together. */
  agentBudgetBytes: number
  /** Memory always left to the OS and other apps. */
  minFreeBytes: number
  /** Ceiling for one agent's whole process tree. */
  perAgentMaxBytes: number
  maxConcurrentAgents: number
  /** Assumed cost of an agent with no recorded runs yet. */
  agentDefaultReserveBytes: number
}

export const GIB = 1024 ** 3

const AGENT_BUDGET_FRACTION = 0.7
const MIN_FREE_FRACTION = 0.15
const MIN_FREE_FLOOR_BYTES = 2 * GIB
const PER_AGENT_FRACTION = 0.35
const PER_AGENT_CEILING_BYTES = 6 * GIB
const AGENT_DEFAULT_RESERVE_BYTES = 2.5 * GIB

// Windows reports a little under the marketed size (16 GB → ~15.8 GiB), so tiers compare in GiB.
function maxConcurrentAgentsFor(totalBytes: number): number {
  const totalGib = totalBytes / GIB
  if (totalGib <= 8) {
    return 1
  }
  if (totalGib <= 16) {
    return 2
  }
  return totalGib <= 32 ? 4 : 6
}

export function computeZotzMemoryGovernorDefaults(totalBytes: number): ZotzMemoryGovernorLimits {
  return {
    agentBudgetBytes: Math.floor(totalBytes * AGENT_BUDGET_FRACTION),
    minFreeBytes: Math.max(MIN_FREE_FLOOR_BYTES, Math.floor(totalBytes * MIN_FREE_FRACTION)),
    perAgentMaxBytes: Math.min(
      PER_AGENT_CEILING_BYTES,
      Math.floor(totalBytes * PER_AGENT_FRACTION)
    ),
    maxConcurrentAgents: maxConcurrentAgentsFor(totalBytes),
    agentDefaultReserveBytes: AGENT_DEFAULT_RESERVE_BYTES
  }
}
