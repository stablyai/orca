import { Loader2, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  normalizeUsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { barColor, clampUsedPercent } from './tooltip'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'

export function InlineUsageBars({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits
  isFetching: boolean
}): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  // Why: tick the session countdown live via one boundary-scheduled clock, not just the usage poll (#5399).
  const now = useResetCountdownClock([limits.session?.resetsAt])
  const usageWindows = [
    limits.session
      ? {
          key: 'session',
          used: clampUsedPercent(limits.session.usedPercent),
          // Why: live reset countdown (matches popover); '5h' window length only when resetsAt is unknown (#5399).
          label: formatRateLimitWindowChipLabel(limits.session, now)
        }
      : null,
    limits.weekly
      ? {
          key: 'weekly',
          used: clampUsedPercent(limits.weekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
        }
      : null,
    limits.fableWeekly
      ? {
          key: 'fableWeekly',
          used: clampUsedPercent(limits.fableWeekly.usedPercent),
          label: translate('auto.components.status.bar.StatusBar.54e8d6bb2d', 'Fable')
        }
      : null
  ].filter((window): window is { key: string; used: number; label: string } => window !== null)

  return (
    <div
      className={`grid w-full items-center gap-1.5 ${isFetching ? 'animate-pulse' : ''}`}
      style={{
        gridTemplateColumns: `repeat(${Math.max(1, usageWindows.length)}, minmax(0, 1fr))`
      }}
    >
      {usageWindows.map((window) => (
        <div key={window.key} className="flex min-w-0 items-center gap-1">
          <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
            <div
              className={`h-full rounded-full ${barColor(window.used)}`}
              style={{ width: `${getDisplayedUsagePercentage(window.used, display)}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatUsagePercentageLabel(window.used, display)} {window.label}
          </span>
        </div>
      ))}
      {usageWindows.length === 0 && limits.status === 'error' ? (
        <span className="text-[10px] text-muted-foreground">
          {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
        </span>
      ) : null}
    </div>
  )
}

export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly && !limits.fableWeekly
}

export function InlineUsageSignInAction({
  isFetching,
  isSigningIn,
  disabled,
  onSignInPointerDown,
  onSignIn
}: {
  isFetching: boolean
  isSigningIn: boolean
  disabled: boolean
  onSignInPointerDown?: () => void
  onSignIn: () => void
}): React.JSX.Element {
  return (
    <div className={`flex w-full items-center gap-2 ${isFetching ? 'animate-pulse' : ''}`}>
      <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        {translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        className="h-6 shrink-0 px-2 text-muted-foreground hover:text-foreground"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignInPointerDown?.()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onSignIn()
        }}
      >
        {isSigningIn ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
      </Button>
    </div>
  )
}

export function InlineUsageSkeleton(): React.JSX.Element {
  return (
    <div className="flex w-full animate-pulse items-center gap-2">
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
      <div className="h-[4px] flex-1 rounded-full bg-muted" />
    </div>
  )
}
