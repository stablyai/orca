import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type {
  ClaudeCompactMetric,
  ExplicitClaudeCompactMetric
} from '../../../../shared/claude-compact-metric'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { getWindowSections } from './tooltip'

export type UsageSection = { label: string; window: RateLimitWindow }

export type CompactUsageSelection =
  | { kind: 'selected'; section: UsageSection }
  | { kind: 'unavailable'; metric: ExplicitClaudeCompactMetric; label: string }
  | { kind: 'empty' }

export function getClaudeCompactMetricLabel(metric: ClaudeCompactMetric): string {
  switch (metric) {
    case 'auto':
      return translate(
        'auto.components.status.bar.ClaudeSwitcherMenu.compactMetricAuto',
        'Automatic'
      )
    case 'session':
      return translate('auto.components.status.bar.tooltip.94038ad2fa', 'Session')
    case 'weekly':
      return translate('auto.components.status.bar.tooltip.252c096536', 'Weekly')
    case 'fableWeekly':
      return translate('auto.components.status.bar.tooltip.a79c64f87e', 'Fable')
  }
}

export function getAvailableUsageSections(provider: ProviderRateLimits): UsageSection[] {
  return getWindowSections(provider).filter(
    (section): section is UsageSection => section.window !== null && section.window !== undefined
  )
}

export function getUsageSectionShortLabel(
  provider: ProviderRateLimits,
  section: UsageSection,
  useRemainingDuration = false
): string {
  if (provider.buckets?.some((bucket) => bucket.name === section.label)) {
    return section.label
  }
  if (section.window === provider.fableWeekly) {
    return getClaudeCompactMetricLabel('fableWeekly')
  }
  if (provider.provider === 'zcode' && section.window === provider.monthly) {
    return section.label
  }
  return useRemainingDuration
    ? formatRateLimitWindowChipLabel(section.window)
    : formatWindowLabel(section.window.windowMinutes)
}

function selectAutomatic(provider: ProviderRateLimits, sections: UsageSection[]): UsageSection {
  const selected = sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
  return { ...selected, label: getUsageSectionShortLabel(provider, selected, true) }
}

export function selectCompactUsage(
  provider: ProviderRateLimits,
  claudeMetric: ClaudeCompactMetric
): CompactUsageSelection {
  if (provider.provider === 'claude' && claudeMetric !== 'auto') {
    const window = provider[claudeMetric]
    if (window === null || window === undefined) {
      return {
        kind: 'unavailable',
        metric: claudeMetric,
        label: getClaudeCompactMetricLabel(claudeMetric)
      }
    }

    const section = { label: getClaudeCompactMetricLabel(claudeMetric), window }
    return {
      kind: 'selected',
      section: { ...section, label: getUsageSectionShortLabel(provider, section, true) }
    }
  }

  const sections = getAvailableUsageSections(provider)
  if (sections.length === 0) {
    return { kind: 'empty' }
  }
  return { kind: 'selected', section: selectAutomatic(provider, sections) }
}
