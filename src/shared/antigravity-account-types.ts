export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  createdAt: number
  updatedAt: number
}

export type AntigravityAccountState = {
  accounts: AntigravityAccountSummary[]
  activeAccountId: string | null
  currentAccount: {
    email: string | null
    subject: string | null
    authMethod: string
    identityKnown: boolean
  } | null
  selectedAccountId: string | null
  resolvedTarget?: { runtime: 'wsl'; wslDistro: string; authorityId: string }
}

export type AntigravityAccountTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  expectedAuthorityId?: string
}
