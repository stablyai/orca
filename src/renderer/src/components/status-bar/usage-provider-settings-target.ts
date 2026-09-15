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
    case 'antigravity':
      // Why: Antigravity sign-in lives in the OS keyring under the `agy` CLI; Orca has no
      // Accounts section that configures it, and Gemini's would configure the wrong provider.
      return null
    case 'opencode-go':
      return 'accounts-opencode-go'
    case 'minimax':
      return 'accounts-minimax'
    case 'grok':
      return 'accounts-grok'
    case 'kimi':
      // Why: Orca must not mutate Kimi's CLI-owned credential lifecycle.
      return null
  }
}
