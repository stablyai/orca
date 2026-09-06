/** Identity Orca stamps into one PTY; inherited values name the parent process's pane. */
export const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

/** Drops identity not explicitly supplied for this spawn. */
export function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}
