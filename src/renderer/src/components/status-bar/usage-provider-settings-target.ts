import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
/** Settings section id to open for a usage provider's accounts. */
export function getUsageProviderAccountsSectionId(
  provider: ProviderRateLimits['provider']
): string | null {
  switch (provider) {
    case 'claude':
      return 'accounts-claude'
    case 'codex':
      return 'accounts-codex'
    case 'gemini':
    case 'antigravity':
      // Why: Antigravity usage currently shares Gemini's OAuth configuration.
      return 'accounts-gemini'
    case 'opencode-go':
      return 'accounts-opencode-go'
    case 'minimax':
      return 'accounts-minimax'
    case 'grok':
      return 'accounts-grok'
    case 'kimi':
    case 'cursor':
      // Why: Orca must not mutate Kimi's or Cursor's CLI-owned credential lifecycle.
      return null
  }
}
