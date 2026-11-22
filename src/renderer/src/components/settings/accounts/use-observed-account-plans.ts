import { useMemo } from 'react'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  indexObservedAccountPlans,
  type ObservedAccountPlans
} from '@/lib/provider-accounts/observed-account-plans'
import { useAppStore } from '../../../store/index'

/** Remote rows read only their owner's streamed usage; this desktop's polls describe other logins.
 *  A provider section hidden by search reads nothing, so usage pushes rebuild no index for it. */
export function useObservedAccountPlans({
  isRemoteAccountScope,
  ownerUsage,
  claudeShown,
  codexShown
}: {
  isRemoteAccountScope: boolean
  ownerUsage: RateLimitState | null
  claudeShown: boolean
  codexShown: boolean
}): { claudeAccountPlans: ObservedAccountPlans; codexAccountPlans: ObservedAccountPlans } {
  const readsLocal = !isRemoteAccountScope
  const usage = isRemoteAccountScope ? ownerUsage : null
  const localClaude = useAppStore((s) => (readsLocal && claudeShown ? s.rateLimits.claude : null))
  const localInactiveClaude = useAppStore((s) =>
    readsLocal && claudeShown ? s.rateLimits.inactiveClaudeAccounts : null
  )
  const localCodex = useAppStore((s) => (readsLocal && codexShown ? s.rateLimits.codex : null))
  const localInactiveCodex = useAppStore((s) =>
    readsLocal && codexShown ? s.rateLimits.inactiveCodexAccounts : null
  )
  const claude = claudeShown ? (usage?.claude ?? localClaude) : null
  const inactiveClaude = claudeShown ? (usage?.inactiveClaudeAccounts ?? localInactiveClaude) : null
  const codex = codexShown ? (usage?.codex ?? localCodex) : null
  const inactiveCodex = codexShown ? (usage?.inactiveCodexAccounts ?? localInactiveCodex) : null
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
