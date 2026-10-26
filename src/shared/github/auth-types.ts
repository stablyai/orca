import type { GhAccountBinding } from './account-binding'

export type GhAuthAccount = {
  host: string
  user: string
  /** True when this is the account gh would use for the next call. */
  active: boolean
  /** Credential environment variable, or null for keyring/file auth. Env-token accounts cannot use gh auth refresh. */
  envToken: 'GITHUB_TOKEN' | 'GH_TOKEN' | null
  source: 'env' | 'keyring'
  scopes: string[]
}

export type GhAuthDiagnostic = {
  /** False when gh CLI is not installed / not on PATH. */
  ghAvailable: boolean
  activeAccount: GhAuthAccount | null
  accounts: GhAuthAccount[]
  /** Token visible to Electron itself; gh may report a different environment source inherited through its shell. */
  envTokenInProcess: 'GITHUB_TOKEN' | 'GH_TOKEN' | null
  missingScopes: string[]
  requiredScopes: string[]
  /** A non-env keyring account on this or another host is available after unsetting the token variable. */
  hasKeyringFallback: boolean
  /** Host needing credentials (e.g. GHES); null when probing without host context. */
  requiredHost: string | null
  /** Whether gh has any account for `requiredHost`; null without host context. */
  requiredHostAuthenticated: boolean | null
}

/** Per-runtime support for `gh auth token --user` (gh ≥ 2.40). */
export type GhMultiAccountCapability = 'supported' | 'unsupported' | 'unknown'

/** Repo binding inventory: list env-token accounts but allow binding only keyring accounts. */
export type GhAccountBindingInventory = {
  capability: GhMultiAccountCapability
  accounts: GhAuthAccount[]
}

export type GhAccountBindingValidationError =
  | 'gh_multi_account_unsupported'
  | 'gh_multi_account_capability_unknown'
  | 'gh_bound_account_unavailable'
  | 'gh_bound_account_not_keyring'
  | 'invalid_binding'

export type GhAccountBindingValidationResult =
  | { ok: true; binding: GhAccountBinding }
  | { ok: false; error: GhAccountBindingValidationError; message?: string }
