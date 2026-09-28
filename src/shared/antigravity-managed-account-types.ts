export type AntigravityManagedAccount = {
  id: string
  label: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  authMethod: 'api-key' | 'oauth' | 'unknown'
  email?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type AntigravityManagedAccountSummary = {
  id: string
  label: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  authMethod: 'api-key' | 'oauth' | 'unknown'
  email?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type AntigravityRateLimitAccountsState = {
  accounts: AntigravityManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: AntigravityManagedAccountRuntimeSelection
}

export type AntigravityManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}
