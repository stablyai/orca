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
      // Kimi and Antigravity keep credentials in their own CLIs; Orca has no account settings for them.
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
  // Saved local Claude accounts offer inline sign-in; remote rosters are absent from local settings and keep the shortcut.
  return !(
    provider === 'claude' &&
    !settings?.activeRuntimeEnvironmentId?.trim() &&
    (settings?.claudeManagedAccounts?.length ?? 0) > 0
  )
}
