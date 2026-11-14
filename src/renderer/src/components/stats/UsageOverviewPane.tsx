import { usageFailureMessage } from './usage-failure-message'
import { useUsageObservation } from '../../store/slices/usage/use-usage-observation'
import { useMemo } from 'react'
import { Activity, CalendarDays, Coins, DatabaseZap, RefreshCw, Sparkles } from 'lucide-react'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import { getRecentUsageDays } from './usage-overview-daily-series'
import { buildUsageOverview, formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { DailyIntensityGrid, ProviderUsageRow, TokenMixBar } from './usage-overview-sections'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'

const RECENT_DAY_COUNT = 42

function formatPercent(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return `${Math.round(value * 100)}%`
}

function formatUpdatedAt(
  timestamp: number | null,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  if (!timestamp) {
    return t('auto.components.stats.usageFormatters.notScannedYet', 'Not scanned yet')
  }
  return t('auto.components.stats.usageFormatters.updatedAt', 'Updated {{time}}', {
    time: new Date(timestamp).toLocaleString(intlLocale)
  })
}

export function UsageOverviewPane(): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const claudeFailure = useAppStore((state) => state.claudeUsageFailure)
  const claudeScanState = useAppStore((state) => state.claudeUsageScanState)
  const claudeSummary = useAppStore((state) => state.claudeUsageSummary)
  const claudeDaily = useAppStore((state) => state.claudeUsageDaily)
  const codexFailure = useAppStore((state) => state.codexUsageFailure)
  const codexScanState = useAppStore((state) => state.codexUsageScanState)
  const codexSummary = useAppStore((state) => state.codexUsageSummary)
  const codexDaily = useAppStore((state) => state.codexUsageDaily)
  const openCodeFailure = useAppStore((state) => state.openCodeUsageFailure)
  const openCodeScanState = useAppStore((state) => state.openCodeUsageScanState)
  const openCodeSummary = useAppStore((state) => state.openCodeUsageSummary)
  const openCodeDaily = useAppStore((state) => state.openCodeUsageDaily)
  const museFailure = useAppStore((state) => state.museUsageFailure)
  const museScanState = useAppStore((state) => state.museUsageScanState)
  const museSummary = useAppStore((state) => state.museUsageSummary)
  const museDaily = useAppStore((state) => state.museUsageDaily)
  const observeClaudeUsage = useAppStore((state) => state.observeClaudeUsage)
  const observeCodexUsage = useAppStore((state) => state.observeCodexUsage)
  const observeOpenCodeUsage = useAppStore((state) => state.observeOpenCodeUsage)
  const observeMuseUsage = useAppStore((state) => state.observeMuseUsage)
  const refreshClaudeUsage = useAppStore((state) => state.refreshClaudeUsage)
  const refreshCodexUsage = useAppStore((state) => state.refreshCodexUsage)
  const refreshOpenCodeUsage = useAppStore((state) => state.refreshOpenCodeUsage)
  const refreshMuseUsage = useAppStore((state) => state.refreshMuseUsage)
  const enableClaudeUsage = useAppStore((state) => state.enableClaudeUsage)
  const enableCodexUsage = useAppStore((state) => state.enableCodexUsage)
  const enableOpenCodeUsage = useAppStore((state) => state.enableOpenCodeUsage)
  const enableMuseUsage = useAppStore((state) => state.enableMuseUsage)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useUsageObservation(observeClaudeUsage)
  useUsageObservation(observeCodexUsage)
  useUsageObservation(observeOpenCodeUsage)
  useUsageObservation(observeMuseUsage)

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
        },
        muse: {
          scanState: museScanState,
          summary: museSummary,
          daily: museDaily
        }
      }),
    [
      claudeDaily,
      claudeScanState,
      claudeSummary,
      codexDaily,
      codexScanState,
      codexSummary,
      museDaily,
      museScanState,
      museSummary,
      openCodeDaily,
      openCodeScanState,
      openCodeSummary
    ]
  )
  const recentDays = useMemo(
    () => getRecentUsageDays(overview.daily, RECENT_DAY_COUNT),
    [overview.daily]
  )
  const isScanning = overview.providers.some((provider) => provider.isScanning)

  const failures = [
    { name: 'Claude', message: usageFailureMessage(claudeFailure, t) },
    { name: 'Codex', message: usageFailureMessage(codexFailure, t) },
    { name: 'OpenCode', message: usageFailureMessage(openCodeFailure, t) },
    { name: 'Muse', message: usageFailureMessage(museFailure, t) }
  ]
  const failureGroups = new Map<string, string[]>()
  for (const { name, message } of failures) {
    if (message) {
      failureGroups.set(message, [...(failureGroups.get(message) ?? []), name])
    }
  }
  const knownProviders = {
    claude: claudeScanState,
    codex: codexScanState,
    opencode: openCodeScanState,
    muse: museScanState
  }
  const allProvidersKnown = Object.values(knownProviders).every(Boolean)
  const canRefresh =
    overview.hasAnyEnabledProvider ||
    failureGroups.size > 0 ||
    Object.values(knownProviders).some((state) => !state)

  const handleRefresh = (): void => {
    void Promise.all([
      claudeScanState?.enabled || claudeFailure || !claudeScanState
        ? refreshClaudeUsage()
        : Promise.resolve(),
      codexScanState?.enabled || codexFailure || !codexScanState
        ? refreshCodexUsage()
        : Promise.resolve(),
      openCodeScanState?.enabled || openCodeFailure || !openCodeScanState
        ? refreshOpenCodeUsage()
        : Promise.resolve(),
      museScanState?.enabled || museFailure || !museScanState
        ? refreshMuseUsage()
        : Promise.resolve()
    ])
  }

  return (
    <div className="space-y-4" data-testid="usage-overview-pane">
      <section className="rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {t('auto.components.stats.UsageOverviewPane.c760c481c5', 'Usage Overview')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatUpdatedAt(overview.lastUpdatedAt, t, intlLocale)}
              {overview.hasPartialCost
                ? t(
                    'auto.components.stats.UsageOverviewPane.55c910f4f1',
                    '- some model prices are unavailable'
                  )
                : ''}
            </p>
            {[...failureGroups].map(([message, names]) => (
              <p key={message} role="alert" className="mt-1 text-xs text-destructive">
                {names.join(', ')}: {message}
              </p>
            ))}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleRefresh}
                disabled={!canRefresh || isScanning}
                aria-label={t(
                  'auto.components.stats.UsageOverviewPane.e06d1baf5c',
                  'Refresh usage overview'
                )}
              >
                <RefreshCw className={`size-3.5 ${isScanning ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.stats.UsageOverviewPane.ca6bc5fded', 'Refresh')}
            </TooltipContent>
          </Tooltip>
        </div>

        {allProvidersKnown && !overview.hasAnyEnabledProvider ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5">
            <div className="max-w-xl space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {t('auto.components.stats.UsageOverviewPane.49405ccc8d', 'Start tracking tokens')}
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
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
                  disabled={!claudeScanState}
                >
                  {t('auto.components.stats.UsageOverviewPane.0ea0cae435', 'Enable Claude')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableCodexUsage()
                  }}
                  disabled={!codexScanState}
                >
                  {t('auto.components.stats.UsageOverviewPane.2f1ee2878b', 'Enable Codex')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableOpenCodeUsage()
                  }}
                  disabled={!openCodeScanState}
                >
                  {t('auto.components.stats.UsageOverviewPane.2d13e57f72', 'Enable OpenCode')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    recordFeatureInteraction('usage-tracking')
                    void enableMuseUsage()
                  }}
                  disabled={!museScanState}
                >
                  {t('auto.components.stats.UsageOverviewPane.enableMuse', 'Enable Muse')}
                </Button>
              </div>
            </div>
          </div>
        ) : overview.hasAnyEnabledProvider ? (
          <>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t('auto.components.stats.UsageOverviewPane.3887b94ce5', 'Total tokens')}
                value={formatUsageTokens(overview.totalTokens, intlLocale)}
                icon={<Sparkles className="size-4" />}
              />
              <StatCard
                label={t('auto.components.stats.UsageOverviewPane.0eaf937335', 'Est. cost')}
                value={formatUsageCost(overview.estimatedCostUsd)}
                icon={<Coins className="size-4" />}
              />
              <StatCard
                label={t('auto.components.stats.UsageOverviewPane.327603fe8b', 'Active days')}
                value={overview.activeDays.toLocaleString(intlLocale)}
                icon={<CalendarDays className="size-4" />}
              />
              <StatCard
                label={t('auto.components.stats.UsageOverviewPane.70f36452d4', 'Cache share')}
                value={formatPercent(overview.cacheShare)}
                icon={<DatabaseZap className="size-4" />}
              />
            </div>

            {!overview.hasAnyData && allProvidersKnown ? (
              <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
                {t(
                  'auto.components.stats.UsageOverviewPane.noLocalUsageYet',
                  'No local Claude, Codex, OpenCode, or Muse usage found yet. The overview will populate after the next agent session writes token logs.'
                )}
              </div>
            ) : overview.hasAnyData ? (
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <DailyIntensityGrid days={recentDays} bestDay={overview.bestDay} />
                <TokenMixBar overview={overview} />
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t('auto.components.stats.UsageOverviewPane.33f7b043d2', 'Providers')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {allProvidersKnown
                ? t(
                    'auto.components.stats.UsageOverviewPane.providersEnabledWithData',
                    '{{enabled}} enabled - {{withData}} with data',
                    { enabled: overview.enabledProviderCount, withData: overview.dataProviderCount }
                  )
                : '—'}
            </p>
          </div>
          <Badge variant="outline" className="gap-1">
            <Activity className="size-3" />
            {t('auto.components.stats.UsageOverviewPane.sessionCount', '{{formatted}} sessions', {
              count: overview.sessions,
              formatted: overview.sessions.toLocaleString(intlLocale),
              defaultValue_one: '{{formatted}} session'
            })}
          </Badge>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {overview.providers.map((provider) => (
            <ProviderUsageRow
              key={provider.id}
              provider={provider}
              totalTokens={overview.totalTokens}
              stateKnown={!!knownProviders[provider.id]}
              onEnable={() => {
                recordFeatureInteraction('usage-tracking')
                if (provider.id === 'claude') {
                  void enableClaudeUsage()
                } else if (provider.id === 'codex') {
                  void enableCodexUsage()
                } else if (provider.id === 'opencode') {
                  void enableOpenCodeUsage()
                } else {
                  void enableMuseUsage()
                }
              }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
