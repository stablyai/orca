import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export function getUsageProviderAccountsSectionId(
  provider: ProviderRateLimits['provider']
): string | null {
  switch (provider) {
    case 'claude':
      return 'accounts-claude'
    case 'codex':
      return 'accounts-codex'
    case 'gemini':
      return 'accounts-gemini'
    case 'opencode-go':
      return 'accounts-opencode-go'
    case 'minimax':
      return 'accounts-minimax'
    case 'grok':
      return 'accounts-grok'
    case 'cursor':
      return 'accounts-cursor'
    case 'antigravity':
    case 'kimi':
      // Why: Orca must not mutate Kimi's CLI-owned credential lifecycle.
      // Antigravity credentials live in the agy CLI; quota is fetched directly via agy.
      return null
    case 'zcode':
      return 'accounts-zcode'
  }
}

/** Whether a signed-out usage row is a Sign in shortcut to Settings instead of the provider's menu. */
export function usageRowSignInOpensSettings(
  provider: ProviderRateLimits['provider'],
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId' | 'claudeManagedAccounts'> | null
): boolean {
  if (getUsageProviderAccountsSectionId(provider) === null) {
    return false
  }
  // Why: with saved accounts the Claude menu lists each one with its own inline Sign in.
  // A remote server's accounts aren't in local settings, so it keeps the shortcut.
  return !(
    provider === 'claude' &&
    !settings?.activeRuntimeEnvironmentId?.trim() &&
    (settings?.claudeManagedAccounts?.length ?? 0) > 0
  )
}
