import { Loader2 } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { barColor, clampUsedPercent } from './tooltip'
import { formatWindowLabel } from '../../../../shared/rate-limit-window-label'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import { formatUsageLimitResetClock } from '../../../../shared/agent-session/failures/agent-session-usage-limit'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { getUsageRosterRowState } from './usage-roster-row-state'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

type InlineUsageWindow = { key: string; used: number; label: string; resetsAt: number | null }

export function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  // Why: tick every reset countdown live via one boundary-scheduled clock, not just the usage poll (#5399).
  const now = useResetCountdownClock([
    limits.session?.resetsAt,
    limits.weekly?.resetsAt,
    limits.fableWeekly?.resetsAt,
    limits.monthly?.resetsAt
  ])
  const usageWindows = [
    limits.session
      ? {
          key: 'session',
          used: clampUsedPercent(limits.session.usedPercent),
          label: formatWindowLabel(limits.session.windowMinutes),
          resetsAt: limits.session.resetsAt
        }
      : null,
    limits.weekly
      ? {
          key: 'weekly',
          used: clampUsedPercent(limits.weekly.usedPercent),
          label: t('auto.components.status.bar.StatusBar.5c938d39ac', 'wk'),
          resetsAt: limits.weekly.resetsAt
        }
      : null,
    limits.fableWeekly
      ? {
          key: 'fableWeekly',
          used: clampUsedPercent(limits.fableWeekly.usedPercent),
          label: t('auto.components.status.bar.StatusBar.54e8d6bb2d', 'Fable'),
          resetsAt: limits.fableWeekly.resetsAt
        }
      : null,
    // Why: matches the status bar chip; monthly is the only limit when there is no 5h/7d window.
    limits.monthly && !limits.session && !limits.weekly
      ? {
          key: 'monthly',
          used: clampUsedPercent(limits.monthly.usedPercent),
          label: formatWindowLabel(limits.monthly.windowMinutes),
          resetsAt: limits.monthly.resetsAt
        }
      : null
  ].filter((window): window is InlineUsageWindow => window !== null)
  // Why: a lapsed token or failed refresh is not a sign-out; ask for a sign-in only when one is confirmed.
  const emptyState =
    usageWindows.length === 0 && limits.status === 'error'
      ? getUsageRosterRowState(limits, false, t)
      : null

  return (
    <div
      className={`grid w-full items-center gap-1.5 ${isFetching ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    >
      {usageWindows.map((window) => {
        const resetsAt =
          window.resetsAt != null && Number.isFinite(new Date(window.resetsAt).getTime())
            ? window.resetsAt
            : null
        return (
          <div key={window.key} className="grid min-w-0 gap-0.5">
            <div className="flex min-w-0 items-center gap-1">
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
                <div
                  className={`h-full rounded-full ${barColor(window.used)}`}
                  style={{ width: `${getDisplayedUsagePercentage(window.used, display)}%` }}
                />
              </div>
              <span className="min-w-[4.5rem] shrink-0 text-right text-3xs tabular-nums text-muted-foreground">
                {formatUsagePercentageLabel(window.used, display, t)} {window.label}
              </span>
              {/* Why: fixed width keeps the reset countdowns in one column across account rows. */}
              <span className="w-11 shrink-0 text-right text-3xs tabular-nums text-muted-foreground">
                {resetsAt != null ? formatResetDuration(resetsAt - now) : null}
              </span>
            </div>
            {resetsAt != null ? (
              <span className="text-right text-3xs tabular-nums text-muted-foreground">
                {t('auto.components.status.bar.InlineUsageBars.resetsAt', 'Resets {{when}}', {
                  when: formatUsageLimitResetClock(resetsAt, now, intlLocale)
                })}
              </span>
            ) : null}
          </div>
        )
      })}
      {emptyState ? (
        <span className="text-3xs text-muted-foreground">
          {emptyState.kind === 'sign-in'
            ? t('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')
            : emptyState.statusLabel}
        </span>
      ) : null}
    </div>
  )
}

export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return (
    limits?.status === 'error' &&
    !limits.session &&
    !limits.weekly &&
    !limits.fableWeekly &&
    !limits.monthly
  )
}

export function InlineUsageSignInAction({
  isSigningIn,
  disabled,
  accountLabel,
  onSignIn
}: {
  isSigningIn: boolean
  disabled: boolean
  accountLabel: string
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem
      asChild
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault()
        onSignIn()
      }}
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabled}
        aria-label={`${t('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}: ${accountLabel}`}
      >
        {isSigningIn ? (
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
      </Button>
    </DropdownMenuItem>
  )
}

export function InlineUsageSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full animate-pulse motion-reduce:animate-none items-center gap-2">
      <div className="h-1 flex-1 rounded-full bg-muted" />
      <div className="h-1 flex-1 rounded-full bg-muted" />
    </div>
  )
}
