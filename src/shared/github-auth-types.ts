/**
 * Shared types for `gh auth status` diagnostics surfaced to the renderer.
 */

export type GhAuthAccount = {
  host: string
  user: string
  /** True when this is the account gh would use for the next call. */
  active: boolean
  /**
   * If gh reports the credential came from an environment variable, the
   * variable's name. Null when the credential came from the keyring/file
   * config. Env-token accounts can't be refreshed by `gh auth refresh`.
   */
  envToken: 'GITHUB_TOKEN' | 'GH_TOKEN' | null
  source: 'env' | 'keyring'
  scopes: string[]
}

export type GhAuthDiagnostic = {
  /** False when gh CLI is not installed / not on PATH. */
  ghAvailable: boolean
  activeAccount: GhAuthAccount | null
  accounts: GhAuthAccount[]
  /**
   * Whether the Electron main process itself sees GITHUB_TOKEN/GH_TOKEN in
   * its environment. Distinct from `activeAccount.envToken` because gh may
   * report an env source even when the variable was set in a parent shell
   * that didn't propagate to Electron, and vice versa.
   */
  envTokenInProcess: 'GITHUB_TOKEN' | 'GH_TOKEN' | null
  missingScopes: string[]
  requiredScopes: string[]
  /**
   * True when there's a non-env keyring account on the same/another host
   * that the user could fall back to by unsetting the env var.
   */
  hasKeyringFallback: boolean
}
