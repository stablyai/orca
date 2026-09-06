/**
 * The marker a structured chat session's child carries when it has NO orchestration identity.
 *
 * It names nothing on purpose — no handle, no pane key, no session id, no token — so it grants no
 * authority and cannot be replayed or impersonated. Its only job is to let a CLI verb that would
 * otherwise GUESS an implicit terminal refuse instead: a structured session has no pane, so every
 * guess resolves to a sibling, and `orchestration check` is destructive by default.
 */
export const ORCA_STRUCTURED_SESSION_ENV = 'ORCA_STRUCTURED_SESSION'

export function isStructuredSessionWithoutIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ORCA_STRUCTURED_SESSION_ENV] ?? '').length > 0
}
