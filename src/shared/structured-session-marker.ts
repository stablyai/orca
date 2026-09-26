/**
 * Marks a structured session's child. It names nothing — no handle, no pane key, no token.
 *
 * Every structured child now also carries its injected session id, and a current CLI checks the id
 * first, so for it the marker only matters when the id is absent: a child spawned by an Orca that
 * predates injection. The marker is still written for the opposite case, a CLI that predates the
 * id, which refuses on it. Either way the answer is refuse, never guess: a structured session has
 * no pane, so every implicit-terminal guess resolves to a sibling, and `orchestration check` is
 * destructive by default.
 *
 * The reader answers only "does this process carry the marker": a current CLI reaches it after the
 * id check has already returned, which is what makes a marked child with an id act as its session.
 */
export const ORCA_STRUCTURED_SESSION_ENV = 'ORCA_STRUCTURED_SESSION'

export function hasStructuredSessionMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ORCA_STRUCTURED_SESSION_ENV] ?? '').length > 0
}
