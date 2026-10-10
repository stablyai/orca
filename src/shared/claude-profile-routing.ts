/** Step 4 enables this only after the credential writers have been removed. */
export function claudeProfileRoutingEnabled(): boolean {
  return false
}

/** The pane's path to the which-account file the `claude` shell function re-reads on every launch. */
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'
