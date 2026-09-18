import type { ClaudeRateLimitAccountsState } from './managed-account-types'

/** Result of changing the default for future Claude launches. Existing
 * executions retain the immutable account/config binding captured at spawn. */
export type ClaudeAccountTransitionResult = {
  state: 'succeeded' | 'rolled_back'
  accountId: string | null
  previousAccountId: string | null
  accounts: ClaudeRateLimitAccountsState
  effect: 'future_launches_only'
  restartRequired: boolean
  boundLiveExecutionCount: number
  unknownLiveExecutionCount: number
  error?: string
}
