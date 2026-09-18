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
    case 'grok':
      return 'accounts-grok'
    case 'devin':
      // Why: the Devin section is read-only status plus a refresh, like Grok's —
      // the deep link is where the "run devin login" instructions live.
      return 'accounts-devin'
    case 'kimi':
      // Why: Orca must not mutate CLI-owned credential lifecycles; Kimi
      // refreshes its own session file, so there is no accounts section.
      return null
  }
}
