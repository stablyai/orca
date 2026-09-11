export type TuiAgentIdentityProbe = 'vercel-fx'

export function getTuiAgentIdentityProbeArgs(probe: TuiAgentIdentityProbe): string[] {
  if (probe === 'vercel-fx') {
    return ['--help']
  }
  return []
}

export function matchesTuiAgentIdentityProbe(
  probe: TuiAgentIdentityProbe,
  output: string
): boolean {
  return probe === 'vercel-fx' && output.includes('Fast, native coding agent for the terminal.')
}
