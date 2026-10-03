import type { ProviderRateLimits } from './rate-limit-types'

export type GrokManagedAccount = {
  id: string
  email: string
  userId: string
  teamId: string | null
}

export type GrokAccountsState = {
  accounts: GrokManagedAccount[]
  activeAccountId: string | null
  usage: Record<string, ProviderRateLimits>
}
