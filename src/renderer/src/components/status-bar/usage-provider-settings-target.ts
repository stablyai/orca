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
    case 'antigravity':
      // Why: Antigravity usage currently shares Gemini's OAuth configuration.
      return 'accounts-gemini'
    case 'opencode-go':
      return 'accounts-opencode-go'
    case 'minimax':
      return 'accounts-minimax'
    case 'openrouter':
      return 'accounts-openrouter'
    case 'grok':
      return 'accounts-grok'
    case 'cursor':
    case 'kimi':
      // Why: Orca must not mutate these providers' CLI-owned credential
      // lifecycles; it only reads the session their CLI already wrote.
      return null
  }
}
