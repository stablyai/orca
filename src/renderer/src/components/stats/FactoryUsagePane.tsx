import { useState } from 'react'
import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import { CalendarClock, ExternalLink, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import { formatUpdatedAt } from './usage-formatters'

export function FactoryUsagePane(): React.JSX.Element {
  const factory = useAppStore((s) => s.rateLimits.factory)
  const factoryApiKeyConfigured = useAppStore((s) => s.rateLimits.factoryApiKeyConfigured)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Why: settled snapshots keep their status during refetches (no 'fetching'
  // repaint), so manual-refresh feedback must be renderer-local, matching the
  // StatusBar refresh button.
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = (): void => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    void refreshRateLimits().finally(() => setIsRefreshing(false))
  }

  const openFactoryAccounts = (): void => {
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-factory' })
    openSettingsPage()
  }

  const paneTitle = translate(
    'auto.components.stats.FactoryUsagePane.g8h9i0j1k2',
    'Factory AI usage'
  )

  if (!factoryApiKeyConfigured) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-card/40 p-4"
        data-testid="factory-usage-pane"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.FactoryUsagePane.b2d3e4f5c6',
                '5-hour, weekly, and monthly quota usage from a Factory API key. Same source as the status bar.'
              )}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              recordFeatureInteraction('usage-tracking')
              openFactoryAccounts()
            }}
          >
            {translate('auto.components.stats.FactoryUsagePane.c3e4f5a6b7', 'Set up in Accounts')}
          </Button>
        </div>
      </div>
    )
  }

  const fiveHourPercent =
    factory?.session && typeof factory.session.usedPercent === 'number'
      ? Math.round(factory.session.usedPercent)
      : null
  const weeklyPercent =
    factory?.weekly && typeof factory.weekly.usedPercent === 'number'
      ? Math.round(factory.weekly.usedPercent)
      : null
  const monthlyPercent =
    factory?.monthly && typeof factory.monthly.usedPercent === 'number'
      ? Math.round(factory.monthly.usedPercent)
      : null
  const nearestReset =
    [factory?.session, factory?.weekly, factory?.monthly].reduce<RateLimitWindow | null>(
      (nearest, window) => {
        if (window === null || window === undefined || window.resetDescription === null) {
          return nearest
        }
        if (nearest === null) {
          return window
        }
        if (window.resetsAt === null) {
          return nearest
        }
        if (nearest.resetsAt === null || window.resetsAt < nearest.resetsAt) {
          return window
        }
        return nearest
      },
      null
    )?.resetDescription ?? null
  const isFetching = isRefreshing || factory?.status === 'fetching'

  return (
    <div
      className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4"
      data-testid="factory-usage-pane"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUpdatedAt(factory?.updatedAt ?? null)}
            {factory?.error
              ? translate('auto.components.stats.FactoryUsagePane.h9i0j1k2l3', ' • {{value0}}', {
                value0: factory.error
              })
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRefresh}
                  disabled={isFetching}
                  aria-label={translate(
                    'auto.components.stats.FactoryUsagePane.i0j1k2l3m4',
                    'Refresh Factory usage'
                  )}
                >
                  <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.stats.FactoryUsagePane.d4f5a6b7c8', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <StatCard
          label={translate('auto.components.stats.FactoryUsagePane.e5a6b7c8d9', '5-hour usage')}
          value={fiveHourPercent !== null ? `${fiveHourPercent}%` : '—'}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={translate('auto.components.stats.FactoryUsagePane.f6b7c8d9e0', 'Weekly usage')}
          value={weeklyPercent !== null ? `${weeklyPercent}%` : '—'}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={translate('auto.components.stats.FactoryUsagePane.a1b2c3d4e5', 'Monthly usage')}
          value={monthlyPercent !== null ? `${monthlyPercent}%` : '—'}
          icon={<CalendarClock className="size-4" />}
        />
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        {nearestReset
          ? translate('auto.components.stats.FactoryUsagePane.b7c8d9e0f1', 'Next reset {{when}}', {
            when: nearestReset
          })
          : ''}
      </p>

      {factory?.usageMetadata?.authProvenance ? (
        <p className="px-1 text-xs text-muted-foreground">{factory.usageMetadata.authProvenance}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-0 text-xs"
          onClick={openFactoryAccounts}
        >
          {translate(
            'auto.components.stats.FactoryUsagePane.a7b8c9d0e1',
            'Factory account settings'
          )}
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
