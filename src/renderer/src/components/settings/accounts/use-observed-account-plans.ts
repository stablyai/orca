import { useMemo } from 'react'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  indexObservedAccountPlans,
  type ObservedAccountPlans
} from '@/lib/provider-accounts/observed-account-plans'
import { useAppStore } from '../../../store/index'

/** Remote rows read only their owner's streamed usage; this desktop's polls describe other logins. */
export function useObservedAccountPlans(
  isRemoteAccountScope: boolean,
  ownerUsage: RateLimitState | null
): { claudeAccountPlans: ObservedAccountPlans; codexAccountPlans: ObservedAccountPlans } {
  const localClaude = useAppStore((s) => s.rateLimits.claude)
  const localInactiveClaude = useAppStore((s) => s.rateLimits.inactiveClaudeAccounts)
  const localCodex = useAppStore((s) => s.rateLimits.codex)
  const localInactiveCodex = useAppStore((s) => s.rateLimits.inactiveCodexAccounts)
  const claude = isRemoteAccountScope ? ownerUsage?.claude : localClaude
  const inactiveClaude = isRemoteAccountScope
    ? ownerUsage?.inactiveClaudeAccounts
    : localInactiveClaude
  const codex = isRemoteAccountScope ? ownerUsage?.codex : localCodex
  const inactiveCodex = isRemoteAccountScope
    ? ownerUsage?.inactiveCodexAccounts
    : localInactiveCodex
  const claudeAccountPlans = useMemo(
    () => indexObservedAccountPlans(claude, inactiveClaude),
    [claude, inactiveClaude]
  )
  const codexAccountPlans = useMemo(
    () => indexObservedAccountPlans(codex, inactiveCodex),
    [codex, inactiveCodex]
  )
  return { claudeAccountPlans, codexAccountPlans }
}
