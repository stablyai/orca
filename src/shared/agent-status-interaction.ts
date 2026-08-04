export type AgentStatusInteraction = {
  kind: 'permission'
}

export function normalizeAgentStatusInteraction(
  value: unknown
): AgentStatusInteraction | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const interaction = value as Record<string, unknown>
  return interaction.kind === 'permission' ? { kind: 'permission' } : undefined
}
