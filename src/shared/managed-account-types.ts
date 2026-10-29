import type { CodexAccountSelectionTarget } from './codex-selection-lane'

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
  /** Whether this host switches accounts before a usage limit; absent from older hosts. */
  autoSwitchEnabled?: boolean
  /** Whether launches bill through the local auth proxy. Absent from older hosts; readers treat that as off. */
  authProxy?: 'on' | 'off'
  /**
   * Windows desktop view of WSL guest billing. `unsupported:wsl` means the guest credential file
   * is unreadable. Absent when this host has no WSL accounts.
   */
  wslAuthProxy?: 'on' | 'unsupported:wsl'
  /** Live sessions billed to each account. Absent from older hosts. */
  assignedSessions?: { accountId: string; count: number }[]
  /** Every live pane and the account it bills. */
  paneAccounts?: ClaudePaneAccountSnapshot[]
  /** Panes whose billed account differs from the folder they were spawned in. */
  paneAssignments?: { ptyId: string; accountId: string }[]
}

/** A Claude switch made over runtime RPC, e.g. from the phone. */
export type ClaudeAccountSelectionChange = {
  target: CodexAccountSelectionTarget
  before: { state: ClaudeRateLimitAccountsState; accountId: string | null }
  after: { state: ClaudeRateLimitAccountsState; accountId: string | null }
}

/** One live Claude pane and the account its next request bills. */
export type ClaudePaneAccountSnapshot = {
  ptyId: string
  paneKey: string | null
  accountId: string
  /** Email local-part, or `local@domain` when two accounts share a local-part. */
  label: string
  email: string
}

/** Pushed when a pane's billed account changes, including when the pane is gone (`accountId` null). */
export type ClaudePaneAssignedEvent = {
  ptyId: string
  paneKey: string | null
  accountId: string | null
  label: string
  email: string
}

/** Orca moved Claude to another account before a usage limit, so running sessions can follow. */
export type ClaudeAutoSwitchedEvent = {
  /** The accounts at the switch, so following it waits on no read another switch could overtake. */
  accounts: ClaudeManagedAccountSummary[]
  fromAccountId: string
  toAccountId: string
  target: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
} & Pick<
  ClaudeRateLimitAccountsState,
  'systemDefaultHome' | 'systemDefaultEmail' | 'systemDefaultOrganizationUuid' | 'paneAssignments'
>

export type ClaudeManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}
