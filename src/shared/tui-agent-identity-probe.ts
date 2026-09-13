export type TuiAgentIdentityProbe = 'vercel-fx'

const TUI_AGENT_IDENTITY_PROBE_ARGS: Record<TuiAgentIdentityProbe, readonly string[]> = {
  'vercel-fx': ['--help']
}

export function getTuiAgentIdentityProbeArgs(probe: TuiAgentIdentityProbe): string[] {
  const args = TUI_AGENT_IDENTITY_PROBE_ARGS[probe]
  if (!args) {
    throw new Error(`Unsupported TUI agent identity probe: ${String(probe)}`)
  }
  return [...args]
}

export function matchesTuiAgentIdentityProbe(
  probe: TuiAgentIdentityProbe,
  output: string
): boolean {
  return probe === 'vercel-fx' && output.includes('Fast, native coding agent for the terminal.')
}
