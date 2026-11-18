import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsageSection } from './usage-headline-sections'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import type { Translate } from '@/i18n/use-translate'
import { formatUsagePercentageLabel } from './usage-percentage-label'

export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim()
  // Codex reports "unknown" when it cannot tell; that is no plan, not a plan named Unknown.
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null
  }
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => {
      const normalized = word.toLowerCase()
      return normalized === 'chatgpt'
        ? 'ChatGPT'
        : normalized.charAt(0).toUpperCase() + normalized.slice(1)
    })
    .join(' ')
}

/** Spells out what a Fable figure limits; MCP windows are not weekly, so they get no title. */
export function scopedUsageTitle(
  p: ProviderRateLimits,
  section: UsageSection,
  display: UsagePercentageDisplay,
  t: Translate
): string | undefined {
  if (section.window !== p.fableWeekly) {
    return undefined
  }
  return t(
    'auto.components.status.bar.UsageRosterPanel.modelWeeklyLimit',
    '{{model}} weekly limit: {{usage}}',
    {
      model: section.label,
      usage: formatUsagePercentageLabel(section.window.usedPercent, display, t)
    }
  )
}
