export const AGENT_STATUS_RUNS_RUNTIME_CAPABILITY = 'agent-status.runs.v1' as const

export const AGENT_STATUS_CAPABILITIES = [AGENT_STATUS_RUNS_RUNTIME_CAPABILITY] as const

export type AgentStatusCapability = (typeof AGENT_STATUS_CAPABILITIES)[number]

const AGENT_STATUS_CAPABILITY_SET: ReadonlySet<string> = new Set(AGENT_STATUS_CAPABILITIES)

const MAX_CAPABILITIES = 256

const MAX_CAPABILITY_LENGTH = 128

/** Encode the status capabilities independently from advertising them on any transport. */
export function serializeAgentStatusCapabilities(
  capabilities: ReadonlySet<AgentStatusCapability>
): string[] {
  return AGENT_STATUS_CAPABILITIES.filter((capability) => capabilities.has(capability))
}

/** Unknown capability strings are ignored so mixed-version peers remain compatible. */
export function deserializeAgentStatusCapabilities(
  value: unknown
): Set<AgentStatusCapability> | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CAPABILITIES ||
    !value.every(
      (capability) =>
        typeof capability === 'string' &&
        capability.length > 0 &&
        capability.length <= MAX_CAPABILITY_LENGTH
    )
  ) {
    return null
  }

  const capabilities = new Set<AgentStatusCapability>()

  for (const capability of value) {
    if (capability === AGENT_STATUS_RUNS_RUNTIME_CAPABILITY) {
      capabilities.add(capability)
    }
  }

  return capabilities
}

export function hasAgentStatusRunCapability(value: unknown): boolean {
  return (
    deserializeAgentStatusCapabilities(value)?.has(AGENT_STATUS_RUNS_RUNTIME_CAPABILITY) === true
  )
}

export function isAgentStatusCapability(value: unknown): value is AgentStatusCapability {
  return typeof value === 'string' && AGENT_STATUS_CAPABILITY_SET.has(value)
}
