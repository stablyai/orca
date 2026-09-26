import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { barColor, formatResetCountdown, getWindowSections, ProviderIcon } from './tooltip'
import { getProviderDisplayName } from './usage-error-copy'
import { formatPlanLabel, usageTextColorClass } from './usage-roster-formatting'
import type { UsageRosterRowState } from './usage-roster-row-state'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'

export type UsageSection = { label: string; window: RateLimitWindow }

// Windows/buckets that actually carry data — absent limits arrive as null, but a
// partial/rehydrated provider can also carry an undefined window; both must be
// dropped so downstream consumers never dereference `window.usedPercent`.
export function usedSections(p: ProviderRateLimits): UsageSection[] {
  return getWindowSections(p).filter(
    (s): s is UsageSection => s.window !== null && s.window !== undefined
  )
}

// Buckets (Gemini Flash/Pro) keep their model name; windows use their duration.
function shortLabel(
  p: ProviderRateLimits,
  section: UsageSection,
  useRemainingDuration = false
): string {
  if (p.buckets?.some((b) => b.name === section.label)) {
    return section.label
  }
  // fableWeekly shares the 7d window with weekly; label it distinctly so the two
  // don't both render as "wk".
  if (section.window === p.fableWeekly) {
    return 'Fable'
  }
  return useRemainingDuration
    ? formatRateLimitWindowChipLabel(section.window)
    : formatWindowLabel(section.window.windowMinutes)
}

export function getTightestUsageSection(p: ProviderRateLimits): UsageSection | null {
  const sections = usedSections(p)
  if (sections.length === 0) {
    return null
  }
  // Why: the footer promises one quiet summary per provider; choose urgency by
  // consumption even when the user displays the complementary “% left” value.
  const tightest = sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
  return { ...tightest, label: shortLabel(p, tightest, true) }
}

// The soonest-resetting window summarizes the agent's next reset in one line.
function soonestResetLabel(sections: UsageSection[], now: number): string | null {
  const resets = sections
    .map((s) => s.window.resetsAt)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  if (resets.length === 0) {
    return null
  }
  return formatResetCountdown(Math.min(...resets) - now)
}

function UsageMetric({
  section,
  label,
  display,
  showBar = true
}: {
  section: UsageSection
  label: string
  display: UsagePercentageDisplay
  showBar?: boolean
}): React.JSX.Element {
  const used = clampUsedPercent(section.window.usedPercent)
  const shown = getDisplayedUsagePercentage(section.window.usedPercent, display)

  return (
    <span data-usage-window={section.label} className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {showBar ? (
        <span data-usage-bar className="h-[5px] w-7 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full', barColor(used))}
            style={{ width: `${shown}%` }}
          />
        </span>
      ) : null}
      <span className={cn('tabular-nums text-[11px]', usageTextColorClass(used))}>{shown}%</span>
    </span>
  )
}

export function UsageRow({
  p,
  display,
  state,
  showSignInAction,
  now,
  mode = 'verbose',
  accountLabel = null,
  selected = false
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  state: UsageRosterRowState
  showSignInAction: boolean
  now: number
  mode?: StatusBarUsageMode
  accountLabel?: string | null
  selected?: boolean
}): React.JSX.Element {
  const sections = usedSections(p)
  const hasUsage = sections.length > 0
  const name = getProviderDisplayName(p.provider)
  const plan = formatPlanLabel(p.planType)
  const reset = hasUsage ? soonestResetLabel(sections, now) : null
  const tightest = mode === 'compact' ? getTightestUsageSection(p) : null

  return (
    <div data-usage-mode={mode} className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          <ProviderIcon provider={p.provider} />
        </span>
        <span className="min-w-0 shrink truncate text-[13px] font-medium text-foreground">
          {name}
          {selected ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
            </span>
          ) : null}
          {plan ? <span className="font-normal text-muted-foreground"> · {plan}</span> : null}
        </span>
        {!hasUsage ? (
          <>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {state.statusLabel}
            </span>
            {showSignInAction ? (
              <span className="ml-auto shrink-0 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground">
                {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
              </span>
            ) : null}
          </>
        ) : tightest ? (
          <span className="ml-auto">
            <UsageMetric
              section={tightest}
              label={tightest.label}
              display={display}
              showBar={false}
            />
          </span>
        ) : reset ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{reset}</span>
        ) : null}
      </div>
      {accountLabel ? (
        <span className="truncate pl-[30px] text-xs text-muted-foreground" title={accountLabel}>
          {accountLabel}
        </span>
      ) : null}
      {hasUsage && mode === 'verbose' ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[30px]">
          {sections.map((section) => (
            <UsageMetric
              key={section.label}
              section={section}
              label={shortLabel(p, section)}
              display={display}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
