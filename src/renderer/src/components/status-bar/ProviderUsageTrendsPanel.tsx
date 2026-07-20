import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { formatUsageTokens } from '@/components/stats/usage-overview-model'
import {
  getTrendsStorageKey,
  PROVIDER_TRENDS_SOURCES,
  readStoredTrendString,
  readStoredTrendValue,
  storeTrendValue,
  type HourlyQuery,
  type TrendsScanState,
  type UsageTrendProvider
} from './provider-usage-trends-configuration'
import { DayTrendsChart, TimeTrendsChart } from './provider-usage-trend-charts'
import {
  formatUsageTrendsRangeCaption,
  getDefaultCustomStartDay,
  getTodayDayKey
} from './provider-usage-trends-date-range'
import { ProviderUsageTrendsSegmentedControl } from './provider-usage-trends-segmented-control'
import { getUsageTrendDetailRows } from './provider-usage-trends-detail-rows'
import {
  buildDayTrend,
  buildHourOfDayModel,
  listLocalDaysInRange,
  listRecentLocalDays,
  TRENDS_WINDOW_DAYS,
  type UsageHourlyPoint,
  type UsageTrendsMode,
  type UsageTrendsWindow
} from './provider-usage-trends-model'

export function ProviderUsageTrendsPanel({
  provider
}: {
  provider: UsageTrendProvider
}): React.JSX.Element {
  const source = PROVIDER_TRENDS_SOURCES[provider]
  const [mode, setMode] = useState<UsageTrendsMode>(() =>
    readStoredTrendValue(getTrendsStorageKey(provider, 'mode'), ['time', 'day'], 'time')
  )
  const [trendsWindow, setTrendsWindow] = useState<UsageTrendsWindow>(() =>
    readStoredTrendValue(
      getTrendsStorageKey(provider, 'window'),
      ['1d', '7d', '30d', '6m', 'custom'],
      '30d'
    )
  )
  const [customStartDay, setCustomStartDay] = useState(() =>
    readStoredTrendString(getTrendsStorageKey(provider, 'custom-start'), getDefaultCustomStartDay())
  )
  const [customEndDay, setCustomEndDay] = useState(() =>
    readStoredTrendString(getTrendsStorageKey(provider, 'custom-end'), getTodayDayKey())
  )
  const [scanState, setScanState] = useState<TrendsScanState | null>(null)
  const [points, setPoints] = useState<UsageHourlyPoint[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)

  const activeWindow = mode === 'day' && trendsWindow === '1d' ? '7d' : trendsWindow
  const query = useMemo<HourlyQuery>(
    () =>
      activeWindow === 'custom'
        ? { startDay: customStartDay, endDay: customEndDay }
        : { days: TRENDS_WINDOW_DAYS[activeWindow] },
    [activeWindow, customEndDay, customStartDay]
  )
  const queryKey = JSON.stringify(query)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setPoints(null)
      try {
        const result = await source.load(query)
        if (!cancelled) {
          setScanState(result.scanState)
          setPoints(result.points)
          setLoadFailed(false)
        }
      } catch {
        // Why: a rejected IPC (e.g. renderer reload during main startup) must
        // not masquerade as the "tracking disabled" consent state.
        if (!cancelled) {
          setLoadFailed(true)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [provider, queryKey, reloadVersion, source, query])

  const handleEnable = async (): Promise<void> => {
    setIsLoading(true)
    try {
      setScanState(await source.enable())
      setLoadFailed(false)
      setReloadVersion((version) => version + 1)
    } catch {
      setLoadFailed(true)
      setIsLoading(false)
    }
  }

  const handleModeChange = (nextMode: UsageTrendsMode): void => {
    setMode(nextMode)
    storeTrendValue(getTrendsStorageKey(provider, 'mode'), nextMode)
  }

  const handleWindowChange = (nextWindow: UsageTrendsWindow): void => {
    setTrendsWindow(nextWindow)
    storeTrendValue(getTrendsStorageKey(provider, 'window'), nextWindow)
  }

  const handleCustomStartChange = (nextStartDay: string): void => {
    const nextEndDay = nextStartDay > customEndDay ? nextStartDay : customEndDay
    setCustomStartDay(nextStartDay)
    setCustomEndDay(nextEndDay)
    storeTrendValue(getTrendsStorageKey(provider, 'custom-start'), nextStartDay)
    storeTrendValue(getTrendsStorageKey(provider, 'custom-end'), nextEndDay)
  }

  const handleCustomEndChange = (nextEndDay: string): void => {
    const nextStartDay = nextEndDay < customStartDay ? nextEndDay : customStartDay
    setCustomStartDay(nextStartDay)
    setCustomEndDay(nextEndDay)
    storeTrendValue(getTrendsStorageKey(provider, 'custom-start'), nextStartDay)
    storeTrendValue(getTrendsStorageKey(provider, 'custom-end'), nextEndDay)
  }

  const selectedDayKeys = useMemo(
    () =>
      activeWindow === 'custom'
        ? listLocalDaysInRange(customStartDay, customEndDay)
        : listRecentLocalDays(TRENDS_WINDOW_DAYS[activeWindow]),
    [activeWindow, customEndDay, customStartDay]
  )
  const hourModel = useMemo(
    () => (mode === 'time' && points ? buildHourOfDayModel(points, selectedDayKeys) : null),
    [mode, points, selectedDayKeys]
  )
  const dayTrend = useMemo(
    () =>
      mode === 'day' && points
        ? buildDayTrend(points, selectedDayKeys, {
            trimPartialFirstMonth: activeWindow === '6m'
          })
        : null,
    [activeWindow, mode, points, selectedDayKeys]
  )

  const captionByWindow: Record<Exclude<UsageTrendsWindow, 'custom'>, string> = {
    '1d': translate('auto.components.status.bar.ProviderUsageTrendsPanel.a943a7552f', 'Today'),
    '7d': translate(
      'auto.components.status.bar.ProviderUsageTrendsPanel.9ee129dafa',
      'Past 7 days'
    ),
    '30d': translate(
      'auto.components.status.bar.ProviderUsageTrendsPanel.185fa97be8',
      'Past 30 days'
    ),
    '6m': translate(
      'auto.components.status.bar.ProviderUsageTrendsPanel.ee44e741c5',
      'Past 6 months'
    )
  }
  const windowOptions: { value: UsageTrendsWindow; label: string }[] = [
    ...(mode === 'time'
      ? [
          {
            value: '1d' as const,
            label: translate('auto.components.status.bar.ProviderUsageTrendsPanel.3556677a27', '1D')
          }
        ]
      : []),
    {
      value: '7d',
      label: translate('auto.components.status.bar.ProviderUsageTrendsPanel.7e4594b3fb', '7D')
    },
    {
      value: '30d',
      label: translate('auto.components.status.bar.ProviderUsageTrendsPanel.9f7ff81364', '30D')
    },
    {
      value: '6m',
      label: translate('auto.components.status.bar.ProviderUsageTrendsPanel.613129b7a5', '6M')
    },
    {
      value: 'custom',
      label: translate('auto.components.status.bar.ProviderUsageTrendsPanel.custom', 'Custom')
    }
  ]
  const hasAnyPoints = (points?.length ?? 0) > 0
  const isEnabled = scanState?.enabled ?? false
  const extraRows = getUsageTrendDetailRows(source.extraRows)

  let body: React.ReactNode
  if (isLoading && !hasAnyPoints) {
    // Why: before the first result lands we do not know whether tracking is
    // even enabled, so a "scanning" message would falsely imply history is
    // being read without consent.
    body =
      scanState?.enabled === true ? (
        <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30">
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.status.bar.ProviderUsageTrendsPanel.2c03693c93',
              'Scanning local usage history…'
            )}
          </span>
        </div>
      ) : (
        <div className="h-full animate-pulse rounded-md border border-border/40 bg-muted/30" />
      )
  } else if (loadFailed) {
    body = (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30 px-3">
        <span className="text-center text-[11px] text-muted-foreground">
          {translate(
            'auto.components.status.bar.ProviderUsageTrendsPanel.c6fe2aabea',
            'Couldn’t load usage trends.'
          )}
        </span>
      </div>
    )
  } else if (!isEnabled) {
    body = (
      <div className="flex h-full flex-col items-start justify-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/30 px-3">
        <div className="text-[12px] font-medium text-foreground">
          {translate(
            'auto.components.status.bar.ProviderUsageTrendsPanel.a3e9ef9aa3',
            'Track local {{providerName}} usage',
            { providerName: source.displayName }
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.ProviderUsageTrendsPanel.ee16f3d219',
            'Chart hourly and daily token trends from local {{providerName}} history. Data never leaves this device.',
            { providerName: source.displayName }
          )}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          disabled={isLoading}
          onClick={() => void handleEnable()}
        >
          {translate(
            'auto.components.status.bar.ProviderUsageTrendsPanel.df2104b90b',
            'Enable usage tracking'
          )}
        </Button>
      </div>
    )
  } else if (!hasAnyPoints) {
    body = (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30 px-3">
        <span className="text-center text-[11px] text-muted-foreground">
          {scanState?.lastScanError ??
            translate(
              'auto.components.status.bar.ProviderUsageTrendsPanel.4fef262630',
              'No local {{providerName}} usage found for this period.',
              { providerName: source.displayName }
            )}
        </span>
      </div>
    )
  } else if (mode === 'time' && hourModel) {
    body = <TimeTrendsChart model={hourModel} />
  } else if (dayTrend) {
    body = <DayTrendsChart trend={dayTrend} extraRows={extraRows} />
  }

  const caption =
    activeWindow === 'custom'
      ? formatUsageTrendsRangeCaption(customStartDay, customEndDay)
      : captionByWindow[activeWindow]

  return (
    <div
      className="flex h-full w-full flex-col gap-1.5 p-2"
      role="region"
      aria-label={translate(
        'auto.components.status.bar.ProviderUsageTrendsPanel.068bb8df88',
        '{{providerName}} usage trend charts',
        { providerName: source.displayName }
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <ProviderUsageTrendsSegmentedControl
          options={[
            {
              value: 'time' as const,
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsPanel.9c58d562da',
                'Time Trends'
              )
            },
            {
              value: 'day' as const,
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsPanel.038ca39d74',
                'Day Trends'
              )
            }
          ]}
          value={mode}
          onChange={handleModeChange}
          ariaLabel={translate(
            'auto.components.status.bar.ProviderUsageTrendsPanel.53ce9bcf71',
            'Chart mode'
          )}
        />
        {isEnabled ? (
          <ProviderUsageTrendsSegmentedControl
            options={windowOptions}
            value={activeWindow}
            onChange={handleWindowChange}
            ariaLabel={translate(
              'auto.components.status.bar.ProviderUsageTrendsPanel.6bf9f80378',
              'Switch trends range'
            )}
          />
        ) : null}
      </div>
      {isEnabled && activeWindow === 'custom' ? (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="space-y-0.5 text-[10px] text-muted-foreground">
            <span>
              {translate('auto.components.status.bar.ProviderUsageTrendsPanel.start', 'Start')}
            </span>
            <Input
              type="date"
              value={customStartDay}
              max={customEndDay}
              onChange={(event) => handleCustomStartChange(event.target.value)}
              className="h-6 px-1.5 text-[10px]"
            />
          </label>
          <label className="space-y-0.5 text-[10px] text-muted-foreground">
            <span>
              {translate('auto.components.status.bar.ProviderUsageTrendsPanel.end', 'End')}
            </span>
            <Input
              type="date"
              value={customEndDay}
              min={customStartDay}
              max={getTodayDayKey()}
              onChange={(event) => handleCustomEndChange(event.target.value)}
              className="h-6 px-1.5 text-[10px]"
            />
          </label>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{caption}</span>
        {mode === 'day' && dayTrend ? (
          <span className="font-mono font-medium">
            {formatUsageTokens(dayTrend.windowTotalTokens)}
          </span>
        ) : null}
      </div>
      {/* Why: the popover row stretches to the tallest column, so the chart
          area absorbs the leftover height instead of leaving dead space. */}
      <div className="min-h-[148px] flex-1">{body}</div>
    </div>
  )
}
