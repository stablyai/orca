import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

// Anthropic renamed Max 5x to Max and Max 20x to Ultra; Claude Code still stores the old tiers.
const RENAMED_CLAUDE_PLANS = new Map([
  ['max_5x', 'Max'],
  ['max_20x', 'Ultra']
])

export function formatPlanLabel(
  planType: string | null | undefined,
  provider: ProviderRateLimits['provider'] | undefined
): string | null {
  const lower = planType?.trim().toLowerCase()
  // Codex reports "unknown" when it cannot tell; that is no plan, not a plan named Unknown.
  if (!lower || lower === 'unknown') {
    return null
  }
  const renamed = provider === 'claude' ? RENAMED_CLAUDE_PLANS.get(lower) : undefined
  if (renamed) {
    return renamed
  }
  return lower
    .split(/[\s_-]+/)
    .map((word) => (word === 'chatgpt' ? 'ChatGPT' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}
