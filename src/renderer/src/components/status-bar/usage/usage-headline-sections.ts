import type { Translate } from '@/i18n/use-translate'
import {
  formatRateLimitWindowChipLabel,
  formatWindowLabel
} from './rate-limit-window-localized-label'
import { CURSOR_MODELS_BUCKET_NAME } from '../../../../../shared/cursor-usage-buckets'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../../shared/usage-percentage-display'
import { getWindowSections } from './provider-usage-panel'
import { USAGE_URGENT_PERCENT } from './usage-health-tone'

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

/** True when the provider reported usage, but only for scoped windows, so there is no headline. */
export function hasOnlyScopedUsage(p: ProviderRateLimits, t?: Translate): boolean {
  return usedSections(p, t).length > 0 && primarySections(p, t).length === 0
}

// Buckets (Gemini Flash/Pro) keep their model name; windows use their duration.
export function shortUsageLabel(
  p: ProviderRateLimits,
  section: UsageSection,
  useRemainingDuration = false
): string {
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

/** Tightest primary window; scoped windows never stand in for a missing primary reading. */
export function getTightestUsageSection(p: ProviderRateLimits, t?: Translate): UsageSection | null {
  const sections = primarySections(p, t)
  if (sections.length === 0) {
    return null
  }
  // Rank by consumption even when the displayed percentage means remaining allowance.
  const tightest = sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
  return { ...tightest, label: shortUsageLabel(p, tightest, true) }
}

export function getUsageHeadlineSection(p: ProviderRateLimits, t?: Translate): UsageSection | null {
  if (p.provider === 'cursor') {
    const primary = primarySections(p, t).find(
      (section) => section.label === CURSOR_MODELS_BUCKET_NAME
    )
    if (primary) {
      return { ...primary, label: shortUsageLabel(p, primary, true) }
    }
  }
  return getTightestUsageSection(p, t)
}

/** The most-used scoped window once it is nearly spent, so the roster can flag it beside the headline. */
export function getUrgentScopedSection(p: ProviderRateLimits, t?: Translate): UsageSection | null {
  const urgent = usedSections(p, t).filter(
    (s) =>
      isScopedUsageWindow(p, s.window) &&
      clampUsedPercent(s.window.usedPercent) >= USAGE_URGENT_PERCENT
  )
  if (urgent.length === 0) {
    return null
  }
  const top = urgent.reduce((a, b) =>
    clampUsedPercent(b.window.usedPercent) > clampUsedPercent(a.window.usedPercent) ? b : a
  )
  return { ...top, label: shortUsageLabel(p, top) }
}
