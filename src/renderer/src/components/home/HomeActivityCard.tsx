import React, { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { formatDuration } from '../stats/usage-formatters'
import { getRecentUsageDays } from '../stats/usage-overview-daily-series'
import { formatUsageCost, formatUsageTokens } from '../stats/usage-overview-model'
import { useUsageOverview } from '../stats/use-usage-overview'
import { HomeCard, HomeCardEmpty } from './HomeCard'
import { useOpenStatsSettings } from './HomeUsageCard'

const SPARKLINE_DAYS = 7

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="truncate text-base font-semibold tabular-nums text-foreground">{value}</p>
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

function TokenSparkline({ values }: { values: number[] }): React.JSX.Element {
  const max = Math.max(1, ...values)
  return (
    <div className="flex h-10 items-end gap-1" aria-hidden>
      {values.map((value, index) => (
        <span
          key={index}
          className="flex-1 rounded-sm bg-primary/60"
          style={{ height: `${Math.max(6, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

export function HomeActivityCard(): React.JSX.Element {
  const overview = useUsageOverview()
  const statsSummary = useAppStore((s) => s.statsSummary)
  const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary)
  const openStatsSettings = useOpenStatsSettings()

  useEffect(() => {
    void fetchStatsSummary()
  }, [fetchStatsSummary])

  const recentDays = useMemo(
    () => getRecentUsageDays(overview.daily, SPARKLINE_DAYS),
    [overview.daily]
  )
  const todayTokens = recentDays.at(-1)?.totalTokens ?? 0
  const weekTokens = recentDays.reduce((sum, day) => sum + day.totalTokens, 0)
  const isScanning = overview.providers.some((provider) => provider.isScanning)

  return (
    <HomeCard
      title={translate('auto.components.home.HomeActivityCard.title', 'Activity')}
      action={
        <Button variant="ghost" size="xs" onClick={openStatsSettings}>
          {translate('auto.components.home.HomeActivityCard.details', 'Stats & Usage')}
        </Button>
      }
    >
      {!overview.hasAnyEnabledProvider ? (
        <HomeCardEmpty>
          {translate(
            'auto.components.home.HomeActivityCard.noProvider',
            'Token tracking is off. Enable a provider in Stats & Usage.'
          )}
        </HomeCardEmpty>
      ) : !overview.hasAnyData ? (
        <HomeCardEmpty>
          {isScanning
            ? translate('auto.components.home.HomeActivityCard.scanning', 'Scanning agent logs…')
            : translate('auto.components.home.HomeActivityCard.noData', 'No token usage yet.')}
        </HomeCardEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label={translate('auto.components.home.HomeActivityCard.today', 'Tokens today')}
              value={formatUsageTokens(todayTokens)}
            />
            <Metric
              label={translate('auto.components.home.HomeActivityCard.week', 'Tokens, last 7 days')}
              value={formatUsageTokens(weekTokens)}
            />
          </div>
          <TokenSparkline values={recentDays.map((day) => day.totalTokens)} />
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label={translate(
                'auto.components.home.HomeActivityCard.sessions',
                'Sessions in tracked range'
              )}
              value={overview.sessions.toLocaleString()}
            />
            <Metric
              label={translate(
                'auto.components.home.HomeActivityCard.cost',
                'Est. cost in tracked range'
              )}
              value={formatUsageCost(overview.estimatedCostUsd)}
            />
          </div>
        </div>
      )}
      {statsSummary ? (
        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border/60 pt-3">
          <Metric
            label={translate('auto.components.home.HomeActivityCard.agents', 'Agents, all time')}
            value={statsSummary.totalAgentsSpawned.toLocaleString()}
          />
          <Metric
            label={translate('auto.components.home.HomeActivityCard.agentTime', 'Agent time')}
            value={formatDuration(statsSummary.totalAgentTimeMs)}
          />
          <Metric
            label={translate('auto.components.home.HomeActivityCard.prs', 'PRs created')}
            value={statsSummary.totalPRsCreated.toLocaleString()}
          />
        </div>
      ) : null}
    </HomeCard>
  )
}
