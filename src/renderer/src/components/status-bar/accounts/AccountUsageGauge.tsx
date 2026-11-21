import React from 'react'
import { useAppStore } from '../../../store'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getTightestUsageSection, usedSections } from '../usage/usage-headline-sections'
import { getUsageRosterRowState } from '../usage/usage-roster-row-state'
import { isClaudeUsageWaitingForClaude } from '../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { formatUsagePercentageLabel } from '../usage/usage-percentage-label'
import { formatLocalizedResetDuration, formatResetsInCaption } from '../usage/usage-reset-caption'
import { useResetCountdownClock } from '../usage/useResetCountdownClock'
import { UsageBar, UsageValue } from '../usage/usage-meter'

export function useNotCheckedDescription(): string {
  const t = useTranslate()
  return t('auto.components.status.bar.tooltip.claude.waiting.label', 'Updates when Claude runs')
}

/** Muted placeholder for an account Orca has not read yet; the reason is a tooltip, not visible text. */
export function AccountUsageNotChecked(): React.JSX.Element {
  const t = useTranslate()
  const description = useNotCheckedDescription()
  return (
    <span
      data-usage-not-checked
      title={description}
      className="flex justify-end text-[11px] text-muted-foreground"
    >
      {t('auto.components.status.bar.UsageRosterPanel.notChecked', 'Not checked')}
    </span>
  )
}

/** True when a Claude account row has no reading yet and will get one the next time Claude runs. */
export function isClaudeAccountNotChecked(limits: ProviderRateLimits | null | undefined): boolean {
  if (!limits) {
    return true
  }
  return usedSections(limits).length === 0 && isClaudeUsageWaitingForClaude(limits)
}

/** One mini bar and value per account, for its tightest primary window (5h or weekly). */
export function AccountUsageGauge({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  const headline = getTightestUsageSection(limits, t)
  if (!headline) {
    if (usedSections(limits, t).length > 0 || isClaudeAccountNotChecked(limits)) {
      // Why: Fable alone says nothing about ordinary requests, so the account reads as unchecked.
      return <AccountUsageNotChecked />
    }
    if (limits.status !== 'error') {
      return null
    }
    const state = getUsageRosterRowState(limits, false, t)
    return (
      <span className="flex justify-end text-3xs text-muted-foreground">
        {state.kind === 'sign-in'
          ? t('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')
          : state.statusLabel}
      </span>
    )
  }
  return (
    <div
      role="img"
      aria-label={formatUsagePercentageLabel(headline.window.usedPercent, display, t)}
      className={`flex items-center justify-end gap-2 ${isFetching ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    >
      {/* Why health: account rows only render inside a provider's details card. */}
      <UsageBar
        usedPercent={headline.window.usedPercent}
        display={display}
        tone="health"
        className="h-[5px] w-[30px] shrink-0"
      />
      <UsageValue
        usedPercent={headline.window.usedPercent}
        display={display}
        className="w-9 text-right text-xs font-medium"
      />
    </div>
  )
}

/**
 * Every primary window with its own bar, percentage and reset countdown — the account list's
 * multi-window view, restoring what the tightest-gauge collapsed to one line (#43594).
 * Falls back to the tightest gauge for states with no readable windows (not-checked, sign-in).
 */
export function AccountUsageWindowsGauge({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  const sections = usedSections(limits, t)
  // Why: one boundary-scheduled clock re-renders this gauge the moment a reset label goes stale,
  // instead of leaving an expired countdown on screen until an unrelated update (#43673 review).
  // Called before the early return so hook order stays stable.
  const now = useResetCountdownClock(sections.map((section) => section.window.resetsAt))
  if (sections.length === 0) {
    return <AccountUsageGauge limits={limits} isFetching={isFetching} />
  }
  return (
    <div
      className={`flex flex-col items-end gap-0.5 ${isFetching ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    >
      {sections.map((section) => {
        const resetLabel = formatLocalizedResetDuration(section.window.resetsAt, now, intlLocale)
        // Why: role="img" makes descendants presentational, so the countdown must live in the
        // label itself or screen readers never announce it (#43673 review).
        // Mirror only the visible countdown: past the reset the slot is empty, and a caption on
        // its own would keep announcing "resets now" with the clock no longer scheduling.
        const resetCaption = resetLabel
          ? formatResetsInCaption(section.window.resetsAt, now, intlLocale, t)
          : null
        const usageLabel = `${section.label} ${formatUsagePercentageLabel(section.window.usedPercent, display, t)}`
        return (
          <div
            key={section.label}
            role="img"
            aria-label={resetCaption ? `${usageLabel}, ${resetCaption}` : usageLabel}
            className="flex items-center justify-end gap-1.5"
          >
            <span className="text-3xs text-muted-foreground">{section.label}</span>
            <UsageBar
              usedPercent={section.window.usedPercent}
              display={display}
              tone="health"
              className="h-[5px] w-[24px] shrink-0"
            />
            <UsageValue
              usedPercent={section.window.usedPercent}
              display={display}
              className="w-9 text-right text-xs font-medium"
            />
            {/* Why: the fixed-width slot always renders, so a window without a reset time
                keeps its bar and percentage aligned with windows that have countdowns. */}
            <span className="w-[46px] text-right text-3xs text-muted-foreground">
              {resetLabel ?? ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}
