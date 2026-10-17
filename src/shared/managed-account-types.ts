export type ManagedDataAccountProvider = 'opencode' | 'devin'

export type ManagedDataAccountSummary = {
  id: string
  label: string
  integrations: string[]
  createdAt: number
}

export type ManagedDataAccountsState = {
  accounts: ManagedDataAccountSummary[]
  activeAccountId: string | null
}

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
  /** Its folder holds no login yet, e.g. an account saved by an older Orca; it needs a sign-in. */
  needsSignIn?: true
  /** Its folder holds no login, so its launches run on System default, signed in to it. */
  runsOnSystemDefault?: true
}

/** A sign-in to a new account folder, or to a saved account's own when `accountId` is given. */
export type ClaudeSignInRequest = {
  accountId?: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

/** A sign-in in progress: `configDir` is the CLAUDE_CONFIG_DIR `claude auth login` runs against. */
export type ClaudeAccountSignIn = {
  accountId: string
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ClaudeRateLimitAccountsState = {
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
  /** The login System default holds, when the host can read it and accounts exist. */
  systemDefaultEmail?: string
  /** An older Orca's copy-based switching once wrote an account's login into System default. */
  systemDefaultMayBeCopied?: boolean
  /** Whether this host switches accounts before a usage limit; absent from older hosts. */
  autoSwitchEnabled?: boolean
}

/** Orca moved Claude to another account before a usage limit, so running sessions can follow. */
export type ClaudeAutoSwitchedEvent = {
  /** The accounts at the switch, so following it waits on no read another switch could overtake. */
  accounts: ClaudeManagedAccountSummary[]
  fromAccountId: string
  toAccountId: string
  target: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
}

export type ClaudeManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}
