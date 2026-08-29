// Includes the setup-sequencing keys: they turn an ordinary pane into an "agent
// launch" for the guard's own decision, so a suite asserting on that decision
// must own them too.
const GIT_CREDENTIAL_GUARD_ENV_RE =
  /^(?:GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ASKPASS|SSH_ASKPASS|WSLENV|ORCA_SEQUENCED_STARTUP_COMMAND|ORCA_SEQUENCED_STARTUP_SCRIPT|ORCA_INTERNAL_TERMINAL_GIT_CREDENTIAL_GUARD_RESTORE|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+))$/

export type SavedGitCredentialGuardEnv = Record<string, string | undefined>

/**
 * Orca's own agent panes export the credential guard, so a suite that asserts on
 * inherited guard state must own this slice of `process.env` rather than read the
 * pane the tests happen to run in.
 */
export function takeGitCredentialGuardEnv(
  seed: Record<string, string> = {}
): SavedGitCredentialGuardEnv {
  const saved: SavedGitCredentialGuardEnv = {}
  for (const key of Object.keys(process.env)) {
    if (GIT_CREDENTIAL_GUARD_ENV_RE.test(key)) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  }
  Object.assign(process.env, seed)
  return saved
}

export function restoreGitCredentialGuardEnv(saved: SavedGitCredentialGuardEnv): void {
  for (const key of Object.keys(process.env)) {
    if (GIT_CREDENTIAL_GUARD_ENV_RE.test(key)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}
