import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { formatCost, formatTokens } from '../stats/usage-formatters'
import UsageDashboardDailyChart from './UsageDashboardDailyChart'
import UsageDashboardModelTable from './UsageDashboardModelTable'
import UsageDashboardQuotaStrip from './UsageDashboardQuotaStrip'
import {
  buildUsageDashboardDailySeries,
  buildUsageDashboardModelRows,
  type UsageDashboardDailyPoint,
  type UsageDashboardModelRow
} from './usage-dashboard-series'
import {
  DASHBOARD_PROVIDER_IDS,
  loadDashboardProviderData,
  type DashboardPeriod,
  type DashboardProviderData,
  type DashboardRange,
  type DashboardScope
} from './usage-dashboard-provider-data'

const PERIODS: readonly DashboardPeriod[] = [7, 14, 30]
const DEFAULT_PERIOD: DashboardPeriod = 14
const DEFAULT_SCOPE: DashboardScope = 'all'

// The provider APIs expose 7/30/90-day windows, so a 14-day view reads the 30-day buckets and the
// series trims them to the selected window.
const RANGE_BY_PERIOD: Record<DashboardPeriod, DashboardRange> = {
  7: '7d',
  14: '30d',
  30: '30d'
}
const RANGE_DAYS_BY_PERIOD: Record<DashboardPeriod, number> = { 7: 7, 14: 30, 30: 30 }

type DashboardData = {
  series: UsageDashboardDailyPoint[]
  modelRows: UsageDashboardModelRow[]
  /** omp keeps a corpus-wide daily aggregate, so its chart cannot honor the orca scope. */
  includesOmp: boolean
}

// Order mirrors the status-bar roster so quota rows do not reshuffle between surfaces.
type RateLimitProviderKey =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'opencodeGo'
  | 'kimi'
  | 'minimax'
  | 'grok'
  | 'cursor'
  | 'zcode'
const QUOTA_PROVIDER_ORDER: readonly RateLimitProviderKey[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencodeGo',
  'kimi',
  'minimax',
  'grok',
  'cursor',
  'zcode'
] satisfies readonly (keyof RateLimitState)[]

export default function UsageDashboardDrawerContent(): React.JSX.Element {
  const rateLimits = useAppStore((state) => state.rateLimits)
  const usagePercentageDisplay = useAppStore((state) => state.usagePercentageDisplay)
  const fetchRateLimits = useAppStore((state) => state.fetchRateLimits)
  const refreshRateLimits = useAppStore((state) => state.refreshRateLimits)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)

  const [period, setPeriod] = useState<DashboardPeriod>(DEFAULT_PERIOD)
  const [scope, setScope] = useState<DashboardScope>(DEFAULT_SCOPE)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)

  const range = RANGE_BY_PERIOD[period]
  const rangeDays = RANGE_DAYS_BY_PERIOD[period]

  useEffect(() => {
    void fetchRateLimits()
  }, [fetchRateLimits])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const loaded = (
          await Promise.all(
            DASHBOARD_PROVIDER_IDS.map((id) => loadDashboardProviderData(id, scope, range))
          )
        ).filter((provider): provider is DashboardProviderData => provider !== null)
        if (cancelled) {
          return
        }
        setData({
          includesOmp: loaded.some((provider) => provider.id === 'omp'),
          series: buildUsageDashboardDailySeries(loaded, period),
          modelRows: buildUsageDashboardModelRows(
            loaded.map((provider) => ({ id: provider.id, rows: provider.models }))
          )
        })
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load the usage dashboard:', error)
          setLoadError(
            translate(
              'auto.components.usageDashboard.UsageDashboardDrawerContent.loadFailed',
              'Could not load usage data.'
            )
          )
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
  }, [period, range, scope, refreshNonce])

  const quotaProviders = useMemo(
    () =>
      QUOTA_PROVIDER_ORDER.map((key) => rateLimits[key]).filter(
        (provider): provider is ProviderRateLimits => provider !== null
      ),
    [rateLimits]
  )

  const handleRefresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1)
    void refreshRateLimits()
  }, [refreshRateLimits])

  const handleOpenFullStats = useCallback(() => {
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const totalTokens = (data?.series ?? []).reduce(
    (sum, point) =>
      sum + point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens,
    0
  )
  const hasKnownCost = (data?.modelRows ?? []).some((row) => row.costUsd !== null)
  // Some rows priced and some not: the total understates the bill, so it reads as partial.
  const hasPartialCost = hasKnownCost && (data?.modelRows ?? []).some((row) => row.costUsd === null)
  // Only omp prices individual days, so the period price comes from the model breakdown instead.
  const totalCost = (data?.modelRows ?? []).reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
  const hasUsage = (data?.modelRows.length ?? 0) > 0 || totalTokens > 0
  // 14 days reads the 30-day buckets, so the cost label names the window it actually covers.
  const costLabel =
    rangeDays === period
      ? translate(
          'auto.components.usageDashboard.UsageDashboardDrawerContent.estimatedCost',
          'Est. cost'
        )
      : translate(
          'auto.components.usageDashboard.UsageDashboardDrawerContent.estimatedCostWindow',
          'Est. cost · {{days}}d',
          { days: rangeDays }
        )

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="usage-dashboard-content">
      <div
        className="flex flex-wrap items-end justify-between gap-2"
        data-testid="usage-dashboard-controls"
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              {translate(
                'auto.components.usageDashboard.UsageDashboardDrawerContent.period',
                'Period'
              )}
            </span>
            <SettingsSegmentedControl<DashboardPeriod>
              value={period}
              onChange={setPeriod}
              size="sm"
              ariaLabel={translate(
                'auto.components.usageDashboard.UsageDashboardDrawerContent.periodAria',
                'Usage period'
              )}
              options={PERIODS.map((value) => ({
                value,
                label: translate(
                  'auto.components.usageDashboard.UsageDashboardDrawerContent.periodDays',
                  '{{days}} days',
                  { days: value }
                )
              }))}
            />
          </div>
          <div className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              {translate(
                'auto.components.usageDashboard.UsageDashboardDrawerContent.scope',
                'Scope'
              )}
            </span>
            <SettingsSegmentedControl<DashboardScope>
              value={scope}
              onChange={setScope}
              size="sm"
              ariaLabel={translate(
                'auto.components.usageDashboard.UsageDashboardDrawerContent.scopeAria',
                'Usage scope'
              )}
              options={[
                {
                  value: 'all',
                  label: translate(
                    'auto.components.usageDashboard.UsageDashboardDrawerContent.scopeAll',
                    'All local usage'
                  )
                },
                {
                  value: 'orca',
                  label: translate(
                    'auto.components.stats.OpenCodeUsagePane.e04c58327c',
                    'Orca worktrees only'
                  )
                }
              ]}
            />
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={handleRefresh}
          aria-label={translate(
            'auto.components.usageDashboard.UsageDashboardDrawerContent.refresh',
            'Refresh usage data'
          )}
        >
          <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loadError !== null ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {loadError}
        </p>
      ) : null}

      <UsageDashboardQuotaStrip
        providers={quotaProviders}
        display={normalizeUsagePercentageDisplay(usagePercentageDisplay)}
      />

      {data === null ? (
        isLoading ? (
          <p
            data-testid="usage-dashboard-loading"
            className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground"
          >
            {translate(
              'auto.components.usageDashboard.UsageDashboardDrawerContent.loading',
              'Loading usage…'
            )}
          </p>
        ) : null
      ) : hasUsage ? (
        <>
          <UsageDashboardDailyChart points={data.series} />
          {scope === 'orca' && data.includesOmp ? (
            <p
              data-testid="usage-dashboard-omp-scope-caption"
              className="px-1 text-xs text-muted-foreground"
            >
              {translate(
                'auto.components.stats.OmpUsagePane.dailyScopeCaption',
                'Daily totals cover all local omp usage; scope applies to sessions, breakdowns and recent sessions.'
              )}
            </p>
          ) : null}
          <UsageDashboardModelTable rows={data.modelRows} rangeDays={rangeDays} />
        </>
      ) : (
        <p
          data-testid="usage-dashboard-empty"
          className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.usageDashboard.UsageDashboardDrawerContent.empty',
            'No local usage found yet. Enable a usage provider in Settings → Stats & Usage.'
          )}
        </p>
      )}

      <footer
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3"
        data-testid="usage-dashboard-footer"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>
            <span className="text-muted-foreground">
              {translate(
                'auto.components.usageDashboard.UsageDashboardDrawerContent.totalTokens',
                'Total tokens'
              )}
            </span>{' '}
            <span className="font-medium tabular-nums text-foreground">
              {formatTokens(totalTokens)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">{costLabel}</span>{' '}
            <span className="font-medium tabular-nums text-foreground">
              {hasKnownCost ? `${formatCost(totalCost)}${hasPartialCost ? '+' : ''}` : '—'}
            </span>
          </span>
          <span className="text-muted-foreground">
            {translate(
              'auto.components.usageDashboard.UsageDashboardDrawerContent.window',
              'Last {{days}} days',
              { days: period }
            )}
          </span>
        </div>
        <Button variant="secondary" size="sm" type="button" onClick={handleOpenFullStats}>
          {translate(
            'auto.components.usageDashboard.UsageDashboardDrawerContent.openFullStats',
            'Open full stats'
          )}
        </Button>
      </footer>
    </div>
  )
}
