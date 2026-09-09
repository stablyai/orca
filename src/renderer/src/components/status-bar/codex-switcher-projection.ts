import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { formatResetCreditExpiry } from './tooltip'

export { getCodexAccountSyncKey } from './provider-account-sync-key'

export function getCodexResetProjection(
  codex: ProviderRateLimits,
  hasActiveRuntimeEnvironment: boolean
): {
  resetCreditCount: number | null
  resetCreditExpiry: string | null
  canRedeemReset: boolean
} {
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  return {
    resetCreditCount,
    resetCreditExpiry,
    // Why: reset credits redeem against the desktop's own Codex login, not a remote account owner's.
    canRedeemReset:
      !hasActiveRuntimeEnvironment && resetCreditCount !== null && resetCreditCount > 0
  }
}
