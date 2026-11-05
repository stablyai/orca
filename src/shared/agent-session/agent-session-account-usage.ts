import type { ProviderRateLimits } from '../rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../codex-reset-credit-scope'

export type AgentSessionAccountUsage =
  | {
      status: 'ok'
      accountLabel: string
      rateLimits: ProviderRateLimits
      reset?: {
        available: number
        expiresAt?: number | null
        expectedScope: CodexResetCreditExpectedScope
      }
    }
  | { status: 'unsupported'; reason: 'codexVersion' | 'apiKeyAuth' }
  | { status: 'failed' }
