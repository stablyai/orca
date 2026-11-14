import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import { formatResetCreditExpiry } from '../usage/provider-usage-panel'
import type { Translate } from '../../../i18n/use-translate'

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
