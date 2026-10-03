export type CodexManagedAccount = {
  id: string
  email: string
  managedHomePath: string
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxHomePath?: string | null
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type CodexManagedAccountSummary = {
  id: string
  email: string
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

/** Live, read-only identity of the user's real ~/.codex used by the
 *  system-default (activeAccountId:null) Codex account. Orca reads this to
 *  display and attribute the system default; it never writes ~/.codex. */
export type CodexSystemDefaultIdentity = {
  /** True when ~/.codex/auth.json exists (signed in via a token file). */
  hasAuth: boolean
  /** 'oauth' = ChatGPT sign-in with an id token (has ChatGPT usage);
   *  'api-key' = env-key/custom provider (no ChatGPT usage);
   *  'none' = signed out or identity could not be resolved. */
  authKind: 'oauth' | 'api-key' | 'none'
  email: string | null
  providerAccountId: string | null
  workspaceLabel: string | null
}

export type CodexRateLimitAccountsState = {
  accounts: CodexManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
  /** Resolved identity of the host system-default (real ~/.codex) account.
   *  Omitted for runtimes where it is not resolved (e.g. per-distro WSL). */
  systemDefault?: CodexSystemDefaultIdentity
}

export type CodexManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}

export type ClaudeManagedAccount = {
  id: string
  email: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type ClaudeManagedAccountSummary = {
  id: string
  email: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
  /** Set only by a host that routes Claude through account profiles. */
  profileReadiness?: ClaudeProfileReadiness
  /** The login Claude itself recorded in this account's profile, when readable. */
  profileEmail?: string
  /** Set when the profile's login is not the row's own, so the row must not be selected. */
  profileIdentityIssue?: 'mismatch' | 'duplicate'
  /** The account works, but its last profile setup left something the user should know. */
  profileSetupIssue?: 'hooks' | 'links' | 'private-history'
}

/** `unverified`: a WSL distro not checked this session (background work never starts one). */
export type ClaudeProfileReadiness =
  | 'ready'
  | 'sign-in-required'
  | 'unsupported'
  | 'unavailable'
  | 'unverified'

export type ClaudeRateLimitAccountsState = {
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
  /** Why new launches may not reach the selected account yet; the picker stays usable. */
  profileRoutingIssue?: string
  /** Sign-ins with no login yet. Kept out of `accounts` on the wire, whose clients require an email. */
  unfinishedAccounts?: ClaudeManagedAccountSummary[]
  /** Local only: terminals an earlier Orca build started are still running and may not follow switching. */
  olderTerminalsRunning?: boolean
  /** The host's own Claude login, read-only. Omitted where it is not read (WSL distros). */
  systemDefault?: ClaudeSystemDefaultIdentity
}

export type ClaudeSystemDefaultIdentity = {
  /** The login Claude's own state file names; null when signed out or unreadable. */
  email: string | null
  /** That login is also a saved account, possibly copied into this slot by an earlier Orca. */
  matchesSavedAccount: boolean
}

export type ClaudeManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}
