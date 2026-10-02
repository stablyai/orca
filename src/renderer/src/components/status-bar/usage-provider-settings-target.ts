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
    case 'zcode':
      // Why: Orca must not mutate Kimi's CLI-owned credential lifecycle.
      // ZCode likewise owns its Coding Plan credential in ~/.zcode/cli/config.json.
      // Antigravity credentials live in the agy CLI; quota is fetched directly via agy.
      return null
  }
}
