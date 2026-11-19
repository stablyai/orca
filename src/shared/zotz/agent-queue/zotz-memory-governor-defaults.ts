/** Memory limits for agents, derived once from the machine's RAM (docs/zotz/PLAN.md, Fase 8f). */
export type ZotzMemoryGovernorLimits = {
  /** Memory always left to the OS and other apps. */
  minFreeBytes: number
  /** Ceiling for one agent's whole process tree. */
  perAgentMaxBytes: number
  /** Assumed cost of an agent with no recorded runs yet. */
  agentDefaultReserveBytes: number
}

export const GIB = 1024 ** 3

const MIN_FREE_FRACTION = 0.15
const MIN_FREE_FLOOR_BYTES = 2 * GIB
const PER_AGENT_FRACTION = 0.35
const PER_AGENT_CEILING_BYTES = 6 * GIB
const AGENT_DEFAULT_RESERVE_BYTES = 2.5 * GIB

export function computeZotzMemoryGovernorDefaults(totalBytes: number): ZotzMemoryGovernorLimits {
  return {
    minFreeBytes: Math.max(MIN_FREE_FLOOR_BYTES, Math.floor(totalBytes * MIN_FREE_FRACTION)),
    perAgentMaxBytes: Math.min(
      PER_AGENT_CEILING_BYTES,
      Math.floor(totalBytes * PER_AGENT_FRACTION)
    ),
    agentDefaultReserveBytes: AGENT_DEFAULT_RESERVE_BYTES
  }
}
