/**
 * Pane identity that Orca stamps into a PTY's environment.
 *
 * Every one of these names a specific pane, so an *inherited* value is always wrong: it names
 * whichever pane the host process was itself launched from. `ORCA_AGENT_LAUNCH_TOKEN` is the
 * damaging member — it is Orca's only in-band proof that Orca launched an agent, and gates keyed
 * on it (the retired-pane status fence, the unmanaged-status-extension fence) read a pane
 * carrying someone else's token as that other pane's launch.
 */
export const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

/**
 * Drops every pane-identity key the spawn did not explicitly ask for, so none survives by
 * inheritance from the host process. A key the caller named is left exactly as given.
 */
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
