export type AgentSessionContextMode = 'standard' | 'max'

export function effectiveAgentContextMode(
  value: string | undefined,
  supportsMaxMode: boolean | undefined
): AgentSessionContextMode | undefined {
  return supportsMaxMode === false
    ? 'standard'
    : value === 'standard' || value === 'max'
      ? value
      : undefined
}
