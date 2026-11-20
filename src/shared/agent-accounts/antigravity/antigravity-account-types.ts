import type { ProviderRateLimits } from '../../agent-usage/rate-limits/rate-limit-types'

export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  createdAt: number
  updatedAt: number
  /** Last reading verified as this account on this runtime; null when never read, absent from older hosts. */
  usage?: ProviderRateLimits | null
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
  /** Host only: new chats run on agy's own home and its signed-in account; false runs them on
   *  Orca's chat home, or on a signed-out agy (`chatAgySignedOut`). Absent from older hosts and WSL. */
  chatUsesAgy?: boolean
  /** That agy's version, when new chats run on it. */
  chatAgyVersion?: string
  /** Host only: new chats run on agy, which isn't signed in yet. Absent from older hosts and WSL. */
  chatAgySignedOut?: boolean
}

export type AntigravityAccountTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}
