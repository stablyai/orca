import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { formatUsageTokens } from '@/components/stats/usage-overview-model'
import type {
  ClaudeUsageHourlyPoint,
  ClaudeUsageScanState
} from '../../../../shared/claude-usage-types'
import {
  buildDayTrend,
  buildHourOfDayModel,
  TRENDS_WINDOW_DAYS,
  type ClaudeUsageTrendsMode,
  type ClaudeUsageTrendsWindow
} from './claude-usage-trends-model'
import { DayTrendsChart, TimeTrendsChart } from './claude-usage-trend-charts'

const MODE_STORAGE_KEY = 'orca-status-bar-claude-trends-mode'
const WINDOW_STORAGE_KEY = 'orca-status-bar-claude-trends-window'
// Why: one fetch covers every selectable window (185d hourly retention);
// range switches then filter client-side without another scan round trip.
const FETCH_WINDOW_DAYS = 185

function readStoredValue<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key)
    return allowed.includes(stored as T) ? (stored as T) : fallback
  } catch {
    return fallback
  }
}

function storeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Why: trends preferences are cosmetic; storage failures must not break the popover.
  }
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            option.value === value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ClaudeUsageTrendsPanel(): React.JSX.Element {
  const [mode, setMode] = useState<ClaudeUsageTrendsMode>(() =>
    readStoredValue(MODE_STORAGE_KEY, ['time', 'day'], 'time')
  )
  const [trendsWindow, setTrendsWindow] = useState<ClaudeUsageTrendsWindow>(() =>
    readStoredValue(WINDOW_STORAGE_KEY, ['1d', '7d', '30d', '6m'], '30d')
  )
  const [scanState, setScanState] = useState<ClaudeUsageScanState | null>(null)
  const [points, setPoints] = useState<ClaudeUsageHourlyPoint[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.claudeUsage.getHourly({ days: FETCH_WINDOW_DAYS })
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
  }, [])

  const handleEnable = async (): Promise<void> => {
    setIsLoading(true)
    try {
      const enabledState = await window.api.claudeUsage.setEnabled({ enabled: true })
      setScanState(enabledState)
      const result = await window.api.claudeUsage.getHourly({ days: FETCH_WINDOW_DAYS })
      setScanState(result.scanState)
      setPoints(result.points)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }

  const handleModeChange = (nextMode: ClaudeUsageTrendsMode): void => {
    setMode(nextMode)
    storeValue(MODE_STORAGE_KEY, nextMode)
  }

  const handleWindowChange = (nextWindow: ClaudeUsageTrendsWindow): void => {
    setTrendsWindow(nextWindow)
    storeValue(WINDOW_STORAGE_KEY, nextWindow)
  }

  // Why: the day chart has no meaningful 24h view, so it borrows the closest
  // range while the picker keeps the shared persisted selection intact.
  const dayWindow: Exclude<ClaudeUsageTrendsWindow, '1d'> =
    trendsWindow === '1d' ? '7d' : trendsWindow

  const hourModel = useMemo(
    () =>
      mode === 'time' && points
        ? buildHourOfDayModel(points, TRENDS_WINDOW_DAYS[trendsWindow])
        : null,
    [mode, points, trendsWindow]
  )
  const dayTrend = useMemo(
    () => (mode === 'day' && points ? buildDayTrend(points, dayWindow) : null),
    [mode, points, dayWindow]
  )

  const captionByWindow: Record<ClaudeUsageTrendsWindow, string> = {
    '1d': translate('auto.components.status.bar.ClaudeUsageTrendsPanel.a943a7552f', 'Today'),
    '7d': translate('auto.components.status.bar.ClaudeUsageTrendsPanel.9ee129dafa', 'Past 7 days'),
    '30d': translate(
      'auto.components.status.bar.ClaudeUsageTrendsPanel.185fa97be8',
      'Past 30 days'
    ),
    '6m': translate('auto.components.status.bar.ClaudeUsageTrendsPanel.ee44e741c5', 'Past 6 months')
  }

  const windowOptions: { value: ClaudeUsageTrendsWindow; label: string }[] = [
    ...(mode === 'time'
      ? [
          {
            value: '1d' as const,
            label: translate('auto.components.status.bar.ClaudeUsageTrendsPanel.3556677a27', '1D')
          }
        ]
      : []),
    {
      value: '7d',
      label: translate('auto.components.status.bar.ClaudeUsageTrendsPanel.7e4594b3fb', '7D')
    },
    {
      value: '30d',
      label: translate('auto.components.status.bar.ClaudeUsageTrendsPanel.9f7ff81364', '30D')
    },
    {
      value: '6m',
      label: translate('auto.components.status.bar.ClaudeUsageTrendsPanel.613129b7a5', '6M')
    }
  ]

  const hasAnyPoints = (points?.length ?? 0) > 0
  const isEnabled = scanState?.enabled ?? false

  let body: React.ReactNode
  if (isLoading && !hasAnyPoints) {
    // Why: before the first result lands we do not know whether tracking is
    // even enabled, so a "scanning" message would falsely imply transcripts
    // are being read without consent.
    body =
      scanState?.enabled === true ? (
        <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30">
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.status.bar.ClaudeUsageTrendsPanel.2c03693c93',
              'Scanning local transcripts…'
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
            'auto.components.status.bar.ClaudeUsageTrendsPanel.c6fe2aabea',
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
            'auto.components.status.bar.ClaudeUsageTrendsPanel.a3e9ef9aa3',
            'Track local Claude usage'
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.ClaudeUsageTrendsPanel.ee16f3d219',
            'Chart hourly and daily token trends from your local Claude Code transcripts. Data never leaves this device.'
          )}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          onClick={() => void handleEnable()}
        >
          {translate(
            'auto.components.status.bar.ClaudeUsageTrendsPanel.df2104b90b',
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
              'auto.components.status.bar.ClaudeUsageTrendsPanel.4fef262630',
              'No local Claude usage found yet.'
            )}
        </span>
      </div>
    )
  } else if (mode === 'time' && hourModel) {
    body = <TimeTrendsChart model={hourModel} window={trendsWindow} />
  } else if (dayTrend) {
    body = <DayTrendsChart trend={dayTrend} window={dayWindow} />
  }

  return (
    <div
      className="flex h-full w-full flex-col gap-1.5 p-2"
      role="region"
      aria-label={translate(
        'auto.components.status.bar.ClaudeUsageTrendsPanel.068bb8df88',
        'Claude usage trend charts'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          options={[
            {
              value: 'time' as const,
              label: translate(
                'auto.components.status.bar.ClaudeUsageTrendsPanel.9c58d562da',
                'Time Trends'
              )
            },
            {
              value: 'day' as const,
              label: translate(
                'auto.components.status.bar.ClaudeUsageTrendsPanel.038ca39d74',
                'Day Trends'
              )
            }
          ]}
          value={mode}
          onChange={handleModeChange}
          ariaLabel={translate(
            'auto.components.status.bar.ClaudeUsageTrendsPanel.068bb8df88',
            'Claude usage trend charts'
          )}
        />
        {isEnabled && hasAnyPoints ? (
          <SegmentedControl
            options={windowOptions}
            value={mode === 'day' ? dayWindow : trendsWindow}
            onChange={handleWindowChange}
            ariaLabel={translate(
              'auto.components.status.bar.ClaudeUsageTrendsPanel.6bf9f80378',
              'Switch trends range'
            )}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{captionByWindow[mode === 'day' ? dayWindow : trendsWindow]}</span>
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
