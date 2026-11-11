import type { AgentSessionRecord } from './lifecycle/agent-session-record'
import { isNativeLocalLocation } from '../execution-host'
import type { ProviderRateLimits } from '../rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../codex-reset-credit-scope'

/** Which account the chat's pinned home holds; the client owns the copy. */
export type AgentSessionUsageAccount =
  | { kind: 'managed'; email: string }
  | { kind: 'system' }
  // An Orca-shared home may hold a different account now; only a live chat knows its email.
  | { kind: 'shared'; email?: string }

export type AgentSessionAccountUsage =
  | {
      status: 'ok'
      account: AgentSessionUsageAccount
      rateLimits: ProviderRateLimits
      reset?: {
        available: number
        expiresAt?: number | null
        expectedScope: CodexResetCreditExpectedScope
      }
    }
  | { status: 'unsupported'; reason: 'codexVersion' | 'apiKeyAuth' }
  | { status: 'failed' }

export function supportsSessionAccountUsage(
  record: Pick<AgentSessionRecord, 'provider' | 'location'> | undefined | null
): boolean {
  return record?.provider === 'codex' && isNativeLocalLocation(record.location)
}
