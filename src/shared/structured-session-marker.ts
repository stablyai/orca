/**
 * The marker a structured chat session's child carried when it had NO orchestration identity.
 *
 * Current hosts no longer write it: every structured child carries its injected session id, which
 * the CLI checks first. The reader stays for a child spawned by an Orca that predates injection,
 * which can still reach a newer CLI through a global install — it must refuse, not guess, because a
 * structured session has no pane, so every implicit-terminal guess resolves to a sibling and
 * `orchestration check` is destructive by default.
 */
export const ORCA_STRUCTURED_SESSION_ENV = 'ORCA_STRUCTURED_SESSION'

export function isStructuredSessionWithoutIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ORCA_STRUCTURED_SESSION_ENV] ?? '').length > 0
}
