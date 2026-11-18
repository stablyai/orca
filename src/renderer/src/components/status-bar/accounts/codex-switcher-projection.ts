import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { formatResetCreditExpiry } from '../usage/provider-usage-panel'
import type { Translate } from '../../../i18n/use-translate'
import type { CodexStatusRuntimeTarget } from './status-bar-runtime-targets'

/** Account rows show the usage of the host that owns the accounts. */
export function getCodexOwnerUsageProjection(
  codex: ProviderRateLimits,
  local: RateLimitState,
  owner: RateLimitState | undefined,
  hasActiveRuntimeEnvironment: boolean
): {
  inactiveCodexAccounts: InactiveAccountUsage[]
  codexTarget: CodexStatusRuntimeTarget
  activeUsage: ProviderRateLimits | null
} {
  if (!hasActiveRuntimeEnvironment) {
    return {
      inactiveCodexAccounts: local.inactiveCodexAccounts,
      codexTarget: local.codexTarget,
      activeUsage: codex
    }
  }
  return {
    inactiveCodexAccounts: owner?.codex?.usageMetadata?.unverifiableOwner
      ? []
      : (owner?.inactiveCodexAccounts ?? []),
    codexTarget: owner?.codexTarget ?? { runtime: 'host', wslDistro: null },
    activeUsage: owner?.codex ?? null
  }
}

export function getCodexResetProjection(
  codex: ProviderRateLimits,
  hasActiveRuntimeEnvironment: boolean,
  t?: Translate
): {
  resetCreditCount: number | null
  resetCreditExpiry: string | null
  canRedeemReset: boolean
} {
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount, t)
      : null
  return {
    resetCreditCount,
    resetCreditExpiry,
    // Why: reset credits redeem against the desktop's own Codex login, not a remote account owner's.
    canRedeemReset:
      !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0
  }
}
