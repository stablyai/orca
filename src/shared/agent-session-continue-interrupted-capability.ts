// Split out of protocol-version.ts, which lists it in RUNTIME_CAPABILITIES. Import it from here.

// Why: a client may call `agentSession.continueInterrupted` (Continue on a reply an Orca stop cut
// off) only on a host that has it; an older host also writes no row naming that stop, so a client
// never offers Continue there.
export const AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY =
  'agent-session.continue-interrupted.v1' as const
