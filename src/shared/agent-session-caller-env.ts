/**
 * The Orca-minted agent session id, injected into a structured session's own child processes, in
 * native chat and in terminal view alike. When it is present it IS the orchestration caller: the
 * CLI sends it in the orchestration envelope and the host resolves it to the session's actor, so no
 * terminal is resolved or guessed on its behalf.
 *
 * Identity by session id assumes one machine and one user. A host boundary (SSH, a paired peer,
 * WSL) re-opens that decision, which is why nothing forwards the id across one as a caller.
 */
export const ORCA_AGENT_SESSION_ID_ENV = 'ORCA_AGENT_SESSION_ID'

export function readInjectedAgentSessionId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const value = env[ORCA_AGENT_SESSION_ID_ENV]?.trim()
  return value ? value : undefined
}
