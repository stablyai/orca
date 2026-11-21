import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { formatResetCreditExpiry } from '../usage/provider-usage-panel'
import type { Translate } from '../../../i18n/use-translate'

export function getCodexResetProjection(
  codex: ProviderRateLimits,
  redeemable: boolean,
  t?: Translate
): {
  resetCreditCount: number | null
  resetCreditExpiry: string | null
  canRedeemReset: boolean
} {
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount, t, {
          inline: true
        })
      : null
  return {
    resetCreditCount,
    resetCreditExpiry,
    canRedeemReset: redeemable && resetCreditCount !== null && resetCreditCount > 0
  }
}
