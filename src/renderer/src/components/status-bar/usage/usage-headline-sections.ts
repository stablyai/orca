import type { Translate } from '@/i18n/use-translate'
import {
  formatRateLimitWindowChipLabel,
  formatWindowLabel
} from './rate-limit-window-localized-label'
import { CURSOR_MODELS_BUCKET_NAME } from '../../../../../shared/agent-usage/rate-limits/cursor-usage-buckets'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { clampUsedPercent } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { isGroupedUsagePool } from '../../../../../shared/agent-usage/display/grouped-usage-pool'
import { getWindowSections } from './provider-usage-panel'
import { USAGE_URGENT_PERCENT } from './usage-health-tone'
import { formatPoolRosterLabel } from './usage-pool-label'

export type UsageSection = { label: string; window: RateLimitWindow }

// Drop null and missing windows from partial/rehydrated snapshots before reading percentages.
export function usedSections(p: ProviderRateLimits, t?: Translate): UsageSection[] {
  return getWindowSections(p, t).filter(
    (s): s is UsageSection => s.window !== null && s.window !== undefined
  )
}

/** Windows that limit one model or tool (Fable, ZCode MCP), never the provider's ordinary requests. */
export function isScopedUsageWindow(p: ProviderRateLimits, window: RateLimitWindow): boolean {
  return window === p.fableWeekly || (p.provider === 'zcode' && window === p.monthly)
}

export function primarySections(p: ProviderRateLimits, t?: Translate): UsageSection[] {
  return usedSections(p, t).filter((s) => !isScopedUsageWindow(p, s.window))
}

/** Highest primary consumption for sorting; -1 when only scoped windows were read. */
export function providerPrimaryMaxUsed(p: ProviderRateLimits, t?: Translate): number {
  const sections = primarySections(p, t)
  return sections.length > 0
    ? Math.max(...sections.map((s) => clampUsedPercent(s.window.usedPercent)))
    : -1
}

// Buckets (Gemini Flash/Pro) keep their model name; windows use their duration.
export function shortUsageLabel(
  p: ProviderRateLimits,
  section: UsageSection,
  useRemainingDuration = false,
  t?: Translate
): string {
  if (isGroupedUsagePool(section.window)) {
    return formatPoolRosterLabel(section.window, p.buckets ?? [], t)
  }
  if (p.buckets?.some((b) => b.name === section.label)) {
    return section.label
  }
  // Distinguish Fable from the other weekly window instead of rendering two wk labels.
  if (section.window === p.fableWeekly) {
    return 'Fable'
  }
  if (p.provider === 'zcode' && section.window === p.monthly) {
    return section.label
  }
  return useRemainingDuration
    ? formatRateLimitWindowChipLabel(section.window)
    : formatWindowLabel(section.window.windowMinutes)
}

/**
 * Which windows a headline may come from. 'primary' (roster, account rows) skips Fable/MCP so they
 * never stand in for a missing primary reading; 'all' (status bar) keeps its original any-window pick.
 */
export type UsageHeadlineScope = 'primary' | 'all'

function headlineSections(
  p: ProviderRateLimits,
  t: Translate | undefined,
  scope: UsageHeadlineScope
): UsageSection[] {
  return scope === 'all' ? usedSections(p, t) : primarySections(p, t)
}

/** Most-consumed window within the scope. */
export function getTightestUsageSection(
  p: ProviderRateLimits,
  t?: Translate,
  scope: UsageHeadlineScope = 'primary'
): UsageSection | null {
  const sections = headlineSections(p, t, scope)
  if (sections.length === 0) {
    return null
  }
  // Rank by consumption even when the displayed percentage means remaining allowance.
  const tightest = sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
  return { ...tightest, label: shortUsageLabel(p, tightest, true, t) }
}

export function getUsageHeadlineSection(
  p: ProviderRateLimits,
  t?: Translate,
  scope: UsageHeadlineScope = 'primary'
): UsageSection | null {
  if (p.provider === 'cursor') {
    const primary = headlineSections(p, t, scope).find(
      (section) => section.label === CURSOR_MODELS_BUCKET_NAME
    )
    if (primary) {
      return { ...primary, label: shortUsageLabel(p, primary, true, t) }
    }
  }
  return getTightestUsageSection(p, t, scope)
}

/** The most-used scoped (Fable/MCP) window at or above minUsedPercent, labeled for the roster. */
export function getTopScopedSection(
  p: ProviderRateLimits,
  t?: Translate,
  minUsedPercent = 0
): UsageSection | null {
  const scoped = usedSections(p, t).filter(
    (s) =>
      isScopedUsageWindow(p, s.window) && clampUsedPercent(s.window.usedPercent) >= minUsedPercent
  )
  if (scoped.length === 0) {
    return null
  }
  const top = scoped.reduce((a, b) =>
    clampUsedPercent(b.window.usedPercent) > clampUsedPercent(a.window.usedPercent) ? b : a
  )
  return { ...top, label: shortUsageLabel(p, top, false, t) }
}

/** The most-used scoped window once it is nearly spent, so the roster can flag it beside the headline. */
export function getUrgentScopedSection(p: ProviderRateLimits, t?: Translate): UsageSection | null {
  return getTopScopedSection(p, t, USAGE_URGENT_PERCENT)
}
