// A routine run whose agent exited because Claude isn't set up for Orca Cloud. Claude Code reports
// it headless as "Not logged in · Please run /login"; the run's summary carries that text and the
// control plane records `agent_exit_<n>` (or `agent_failed:<note>`). Every surface (desktop, CLI)
// says how to set Claude up instead of the CLI's own words (END-PASS n64 P3).

const CLAUDE_NOT_SIGNED_IN = /not logged in|please run \/login|\brun \/login\b/i

export function isRoutineRunAgentSignInFailure(
  error: string | null | undefined,
  summary?: string | null
): boolean {
  const code = (error ?? '').split(':', 1)[0]?.trim() ?? ''
  const agentFailed = code.startsWith('agent_exit') || code === 'agent_failed'
  return agentFailed && CLAUDE_NOT_SIGNED_IN.test(`${summary ?? ''} ${error ?? ''}`)
}

/** The plain-English line, for surfaces without the desktop's translations (the CLI). */
export const ROUTINE_RUN_CLAUDE_NOT_SET_UP =
  'Claude isn’t set up for Orca Cloud, so this run couldn’t start it. Set it up once in Settings → Agent accounts, then run the routine again.'
