import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { formatResetCreditExpiry } from './tooltip'

export function getCodexAccountSyncKey(settings: GlobalSettings | null | undefined): string {
  if (!settings) {
    return 'no-settings'
  }
  return `${settings.activeRuntimeEnvironmentId?.trim() || 'local'}:${settings.activeCodexManagedAccountId ?? 'system'}:${JSON.stringify(settings.activeCodexManagedAccountIdsByRuntime ?? null)}:${settings.codexManagedAccounts.map((account) => `${account.id}:${account.updatedAt}`).join('|')}`
}

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
