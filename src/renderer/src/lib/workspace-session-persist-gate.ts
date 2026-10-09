import type { AppState } from '../store'

/** Why (issue #1158): require both flags so a hydration failure can't overwrite orca-data.json with empty error-path state. */
export function shouldPersistWorkspaceSession(
  state: Pick<AppState, 'workspaceSessionReady' | 'hydrationSucceeded'>
): boolean {
  return state.workspaceSessionReady && state.hydrationSucceeded
}
