import type { CodexAccountSelectionTarget } from './codex/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from './claude/claude-account-switch-settings'

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
  /** The name the user gave this account; the email stays its sign-in identity. */
  displayName?: string
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

/** Read-only identity of real ~/.codex for system-default (activeAccountId:null) display/attribution; this path never writes it. */
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
  /** Host’s real ~/.codex identity; omitted where unresolved, such as per-distro WSL. */
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
  /** The name the user gave this account; the email stays its sign-in identity. */
  displayName?: string
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
  /** The login it was added with, once its folder signs in to another one (e.g. `/login` in Claude). */
  addedAs?: { email: string; organizationName: string | null }
  /** The host folder its launches use; a legacy account's saved path may name an older one. */
  home?: string
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
  systemDefaultOrganizationUuid?: string
  /** The host folder System default launches use, when accounts exist. */
  systemDefaultHome?: string
  /** An older Orca's copy-based switching once wrote an account's login into System default. */
  systemDefaultMayBeCopied?: boolean
}

/** A Claude switch made over runtime RPC, e.g. from the phone. */
export type ClaudeAccountSelectionChange = {
  target: CodexAccountSelectionTarget
  before: { state: ClaudeRateLimitAccountsState; accountId: string | null }
  after: { state: ClaudeRateLimitAccountsState; accountId: string | null }
  /** The switching client's own choice for running sessions; absent, the host's setting decides. */
  runningSessions?: ClaudeAccountSwitchRunningSessions
  /** Nothing was selected: this answers the Ask a switch to this account left open. */
  answersAskFor?: string | null
}

/** What a server did with its running Claude terminals when its account switched. */
export type ClaudeHostRunningSessionsMove = {
  /** Restarting on the new account, each resuming its conversation. */
  restarting: number
  /** Running Claude terminals that may still be on the previous account. */
  notMoved: number
  /** Of `notMoved`, those the server restarts when the same switch is sent again with `restart`. */
  canRestart?: number
}

/** `runningSessions` is absent from older servers, and from hosts whose window moves its own. */
export type ClaudeAccountSelectResult = ClaudeRateLimitAccountsState & {
  runningSessions?: ClaudeHostRunningSessionsMove
}

/** Moves a host's running Claude sessions after a switch; a host without a window reports them. */
export type ClaudeAccountSelectedHandler = (
  change: ClaudeAccountSelectionChange
) => Promise<ClaudeHostRunningSessionsMove | undefined>

export type ClaudeManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}
