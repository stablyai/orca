import { useEffect, useMemo, useState } from 'react'
import { Activity, CalendarDays, Coins, DatabaseZap, RefreshCw, Sparkles } from 'lucide-react'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import {
  buildDailyOverview,
  getRecentUsageDays,
  rankUsageIntensities
} from './usage-overview-daily-series'
import type { UsageOverviewDailyPoint, UsageOverviewInput } from './usage-overview-types'
import { buildUsageOverview, formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { DailyIntensityGrid, ProviderUsageRow, TokenMixBar } from './usage-overview-sections'
import { translate } from '@/i18n/i18n'

const RECENT_DAY_COUNT = 42
// Why: the provider tabs default to a 30d range but the heatmap draws 42 days,
// so it fetches its own series wide enough to cover every cell it renders.
const HEATMAP_RANGE = '90d'

type HeatmapDaily = {
  claude: UsageOverviewInput['claude']['daily']
  codex: UsageOverviewInput['codex']['daily']
  opencode: UsageOverviewInput['opencode']['daily']
}

const EMPTY_HEATMAP_DAILY: HeatmapDaily = { claude: [], codex: [], opencode: [] }

/**
 * Highest-volume day in a series.
 * @param days - Daily points, any order.
 * @returns The day with the most tokens, or `null` for an empty series.
 */
function pickBestDay(days: UsageOverviewDailyPoint[]): UsageOverviewDailyPoint | null {
  return days.reduce<UsageOverviewDailyPoint | null>(
    (best, entry) => (!best || entry.totalTokens > best.totalTokens ? entry : best),
    null
  )
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return `${Math.round(value * 100)}%`
}

function formatUpdatedAt(timestamp: number | null): string {
  if (!timestamp) {
    return 'Not scanned yet'
  }
  return `Updated ${new Date(timestamp).toLocaleString()}`
}

/**
 * Combined Claude, Codex, and OpenCode usage: totals, a 42-day intensity heatmap,
 * token mix, and per-provider rows.
 * @returns The Stats & Usage overview pane.
 */
export function UsageOverviewPane(): React.JSX.Element {
  const claudeScanState = useAppStore((state) => state.claudeUsageScanState)
  const claudeSummary = useAppStore((state) => state.claudeUsageSummary)
  const claudeDaily = useAppStore((state) => state.claudeUsageDaily)
  const codexScanState = useAppStore((state) => state.codexUsageScanState)
  const codexSummary = useAppStore((state) => state.codexUsageSummary)
  const codexDaily = useAppStore((state) => state.codexUsageDaily)
  const openCodeScanState = useAppStore((state) => state.openCodeUsageScanState)
  const openCodeSummary = useAppStore((state) => state.openCodeUsageSummary)
  const openCodeDaily = useAppStore((state) => state.openCodeUsageDaily)
  const claudeScope = useAppStore((state) => state.claudeUsageScope)
  const codexScope = useAppStore((state) => state.codexUsageScope)
  const openCodeScope = useAppStore((state) => state.openCodeUsageScope)
  const fetchClaudeUsage = useAppStore((state) => state.fetchClaudeUsage)
  const fetchCodexUsage = useAppStore((state) => state.fetchCodexUsage)
  const fetchOpenCodeUsage = useAppStore((state) => state.fetchOpenCodeUsage)
  const refreshClaudeUsage = useAppStore((state) => state.refreshClaudeUsage)
  const refreshCodexUsage = useAppStore((state) => state.refreshCodexUsage)
  const refreshOpenCodeUsage = useAppStore((state) => state.refreshOpenCodeUsage)
  const enableClaudeUsage = useAppStore((state) => state.enableClaudeUsage)
  const enableCodexUsage = useAppStore((state) => state.enableCodexUsage)
  const enableOpenCodeUsage = useAppStore((state) => state.enableOpenCodeUsage)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchClaudeUsage()
    void fetchCodexUsage()
    void fetchOpenCodeUsage()
  }, [fetchClaudeUsage, fetchCodexUsage, fetchOpenCodeUsage])

  const overview = useMemo(
    () =>
      buildUsageOverview({
        claude: {
          scanState: claudeScanState,
          summary: claudeSummary,
          daily: claudeDaily
        },
        codex: {
          scanState: codexScanState,
          summary: codexSummary,
          daily: codexDaily
        },
        opencode: {
          scanState: openCodeScanState,
          summary: openCodeSummary,
          daily: openCodeDaily
        }
      }),
    [
      claudeDaily,
      claudeScanState,
      claudeSummary,
      codexDaily,
      codexScanState,
      codexSummary,
      openCodeDaily,
      openCodeScanState,
      openCodeSummary
    ]
  )
  const [heatmapDaily, setHeatmapDaily] = useState<HeatmapDaily>(EMPTY_HEATMAP_DAILY)
  const claudeEnabled = claudeScanState?.enabled === true
  const codexEnabled = codexScanState?.enabled === true
  const openCodeEnabled = openCodeScanState?.enabled === true
  const scanKey = [
    claudeScanState?.lastScanCompletedAt,
    codexScanState?.lastScanCompletedAt,
    openCodeScanState?.lastScanCompletedAt
  ].join('|')
  useEffect(() => {
    let cancelled = false
    // Why: one provider failing must not blank the others' cells.
    const loadDaily = <Daily,>(
      name: string,
      enabled: boolean,
      fetch: () => Promise<{ daily?: Daily[] } | undefined>
    ): Promise<Daily[]> =>
      enabled
        ? fetch()
            .then((snapshot) => snapshot?.daily ?? [])
            .catch((error: unknown) => {
              console.error(`Failed to load ${name} usage heatmap:`, error)
              return []
            })
        : Promise.resolve([])
    const load = async (): Promise<void> => {
      const [claude, codex, opencode] = await Promise.all([
        loadDaily('Claude', claudeEnabled, () =>
          window.api.claudeUsage.getSnapshot({ scope: claudeScope, range: HEATMAP_RANGE, limit: 1 })
        ),
        loadDaily('Codex', codexEnabled, () =>
          window.api.codexUsage.getSnapshot({ scope: codexScope, range: HEATMAP_RANGE, limit: 1 })
        ),
        loadDaily('OpenCode', openCodeEnabled, () =>
          window.api.openCodeUsage.getSnapshot({
            scope: openCodeScope,
            range: HEATMAP_RANGE,
            limit: 1
          })
        )
      ])
      if (!cancelled) {
        setHeatmapDaily({ claude, codex, opencode })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [
    claudeEnabled,
    claudeScope,
    codexEnabled,
    codexScope,
    openCodeEnabled,
    openCodeScope,
    scanKey
  ])
  const recentDays = useMemo(() => {
    const windowed = getRecentUsageDays(
      buildDailyOverview({
        claude: { scanState: claudeScanState, summary: claudeSummary, daily: heatmapDaily.claude },
        codex: { scanState: codexScanState, summary: codexSummary, daily: heatmapDaily.codex },
        opencode: {
          scanState: openCodeScanState,
          summary: openCodeSummary,
          daily: heatmapDaily.opencode
        }
      }),
      RECENT_DAY_COUNT
    )
    // Why: shades are quartiles of the days on screen, not of the whole fetched history.
    const intensities = rankUsageIntensities(windowed.map((entry) => entry.totalTokens))
    return windowed.map((entry, index) => ({ ...entry, intensity: intensities[index] ?? 0 }))
  }, [
    claudeScanState,
    claudeSummary,
    codexScanState,
    codexSummary,
    heatmapDaily,
    openCodeScanState,
    openCodeSummary
  ])
  const heatmapBestDay = useMemo(() => pickBestDay(recentDays), [recentDays])
  const isScanning = overview.providers.some((provider) => provider.isScanning)

  const handleRefresh = (): void => {
    void Promise.all([
      claudeScanState?.enabled ? refreshClaudeUsage() : Promise.resolve(),
      codexScanState?.enabled ? refreshCodexUsage() : Promise.resolve(),
      openCodeScanState?.enabled ? refreshOpenCodeUsage() : Promise.resolve()
    ])
  }

  return (
    <div className="space-y-4" data-testid="usage-overview-pane">
      <section className="rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {translate('auto.components.stats.UsageOverviewPane.c760c481c5', 'Usage Overview')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatUpdatedAt(overview.lastUpdatedAt)}
              {overview.hasPartialCost
                ? translate(
                    'auto.components.stats.UsageOverviewPane.55c910f4f1',
                    '- some model prices are unavailable'
                  )
                : ''}
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleRefresh}
                disabled={!overview.hasAnyEnabledProvider || isScanning}
                aria-label={translate(
                  'auto.components.stats.UsageOverviewPane.e06d1baf5c',
                  'Refresh usage overview'
                )}
              >
                <RefreshCw className={`size-3.5 ${isScanning ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.stats.UsageOverviewPane.ca6bc5fded', 'Refresh')}
            </TooltipContent>
          </Tooltip>
        </div>

        {!overview.hasAnyEnabledProvider ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5">
            <div className="max-w-xl space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {translate(
                    'auto.components.stats.UsageOverviewPane.49405ccc8d',
                    'Start tracking tokens'
                  )}
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {translate(
                    'auto.components.stats.UsageOverviewPane.6c00c46815',
                    'Enable a provider to scan local agent logs and build the combined token ledger.'
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableClaudeUsage()
                  }}
                >
                  {translate('auto.components.stats.UsageOverviewPane.0ea0cae435', 'Enable Claude')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableCodexUsage()
                  }}
                >
                  {translate('auto.components.stats.UsageOverviewPane.2f1ee2878b', 'Enable Codex')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableOpenCodeUsage()
                  }}
                >
                  {translate(
                    'auto.components.stats.UsageOverviewPane.2d13e57f72',
                    'Enable OpenCode'
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={translate(
                  'auto.components.stats.UsageOverviewPane.3887b94ce5',
                  'Total tokens'
                )}
                value={formatUsageTokens(overview.totalTokens)}
                icon={<Sparkles className="size-4" />}
              />
              <StatCard
                label={translate('auto.components.stats.UsageOverviewPane.0eaf937335', 'Est. cost')}
                value={formatUsageCost(overview.estimatedCostUsd)}
                icon={<Coins className="size-4" />}
              />
              <StatCard
                label={translate(
                  'auto.components.stats.UsageOverviewPane.327603fe8b',
                  'Active days'
                )}
                value={overview.activeDays.toLocaleString()}
                icon={<CalendarDays className="size-4" />}
              />
              <StatCard
                label={translate(
                  'auto.components.stats.UsageOverviewPane.70f36452d4',
                  'Cache share'
                )}
                value={formatPercent(overview.cacheShare)}
                icon={<DatabaseZap className="size-4" />}
              />
            </div>

            {!overview.hasAnyData ? (
              <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
                {translate(
                  'auto.components.stats.UsageOverviewPane.60002bb22f',
                  'No local Claude, Codex, or OpenCode usage found yet. The overview will populate after the next agent session writes token logs.'
                )}
              </div>
            ) : (
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <DailyIntensityGrid days={recentDays} bestDay={heatmapBestDay} />
                <TokenMixBar overview={overview} />
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {translate('auto.components.stats.UsageOverviewPane.33f7b043d2', 'Providers')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {overview.enabledProviderCount}{' '}
              {translate('auto.components.stats.UsageOverviewPane.ecb0cd8a4c', 'enabled -')}{' '}
              {overview.dataProviderCount}{' '}
              {translate('auto.components.stats.UsageOverviewPane.444585cb41', 'with data')}
            </p>
          </div>
          <Badge variant="outline" className="gap-1">
            <Activity className="size-3" />
            {overview.sessions.toLocaleString()}{' '}
            {translate('auto.components.stats.UsageOverviewPane.22ed1b7669', 'sessions')}
          </Badge>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {overview.providers.map((provider) => (
            <ProviderUsageRow
              key={provider.id}
              provider={provider}
              totalTokens={overview.totalTokens}
              onEnable={() => {
                recordFeatureInteraction('usage-tracking')
                if (provider.id === 'claude') {
                  void enableClaudeUsage()
                } else if (provider.id === 'codex') {
                  void enableCodexUsage()
                } else {
                  void enableOpenCodeUsage()
                }
              }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
