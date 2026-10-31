import { useMemo, useState } from 'react'
import { CalendarDays, Coins, DatabaseZap, RefreshCw, Sparkles } from 'lucide-react'
import type { UsageHistoryProvider } from '../../../../shared/usage-history-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { StatCard } from './StatCard'
import { UsageHistoryFilters } from './UsageHistoryFilters'
import {
  UsageHistoryBreakdowns,
  UsageHistoryDailyChart,
  UsageHistorySessions
} from './UsageHistoryDetails'
import {
  filterUsageHistory,
  formatCacheReadShare,
  totalUsageHistory,
  type UsageHistorySelection
} from './usage-history-model'
import { formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { useUsageHistory } from './use-usage-history'
import { usageHistoryAccountLabels } from './usage-history-accounts'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getIntlLocale, translate } from '@/i18n/i18n'

const PROVIDERS: readonly { value: UsageHistoryProvider; label: string }[] = [
  {
    value: 'claude',
    get label() {
      return getAgentLabel('claude')
    }
  },
  {
    value: 'codex',
    get label() {
      return getAgentLabel('codex')
    }
  },
  {
    value: 'opencode',
    get label() {
      return getAgentLabel('opencode')
    }
  },
  {
    value: 'muse',
    get label() {
      return getAgentLabel('muse')
    }
  }
]

export function UsageOverviewPane({
  target,
  ownerLabel = translate('stats.usage.localHost', 'This device'),
  initialProvider = 'all'
}: {
  target?: RuntimeClientTarget
  ownerLabel?: string
  initialProvider?: UsageHistoryProvider | 'all'
} = {}): React.JSX.Element {
  const { sources, accounts, isRefreshing, refresh, enable } = useUsageHistory(target)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const [selection, setSelection] = useState<UsageHistorySelection>({
    range: '30d',
    scope: 'all',
    provider: initialProvider,
    account: null,
    model: null,
    project: null,
    day: null
  })
  const allRows = useMemo(
    () => sources.flatMap((source) => (source.enabled ? source.rows : [])),
    [sources]
  )
  const today = sources.find((source) => source.historyToday)?.historyToday
  const datedSelection = useMemo(() => ({ ...selection, today }), [selection, today])
  const rows = useMemo(() => filterUsageHistory(allRows, datedSelection), [allRows, datedSelection])
  const totals = useMemo(() => totalUsageHistory(rows), [rows])
  const accountLabels = usageHistoryAccountLabels(accounts)
  const unattributed = filterUsageHistory(allRows, { ...datedSelection, account: 'unknown' })
  const days = new Set(rows.map((row) => row.day))
  const hasRows = rows.length > 0
  const hasSupportedSource = sources.some((source) => source.status === 'ready')
  const activeSources = sources.filter(
    (source) => selection.provider === 'all' || source.provider === selection.provider
  )
  const hasCoverageGap = activeSources.some(
    (source) =>
      source.status !== 'ready' ||
      !source.enabled ||
      source.error ||
      source.needsRescan ||
      source.lastScanCompletedAt === null
  )
  return (
    <div className="@container space-y-4" data-testid="usage-overview-pane">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('stats.usage.history.title', 'Historical usage')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate('stats.usage.history.owner', '{{host}} · Recorded agent logs', {
              host: ownerLabel
            })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          aria-label={translate('stats.usage.history.refresh', 'Refresh historical usage')}
        >
          <RefreshCw className="size-3.5" />
          {translate('stats.usage.refresh', 'Refresh')}
        </Button>
      </div>
      <UsageHistoryFilters
        allRows={allRows}
        selection={datedSelection}
        setSelection={setSelection}
        providers={PROVIDERS}
        accountLabels={accountLabels}
      />
      <div
        className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4"
        data-testid="usage-history-totals"
      >
        <StatCard
          label={translate('stats.usage.tokens', 'Tokens')}
          value={hasRows ? formatUsageTokens(totals.totalTokens) : '—'}
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label={
            totals.hasPartialCost
              ? translate('stats.usage.estimate.partial', 'Partial API-equivalent estimate')
              : translate('stats.usage.estimate.title', 'API-equivalent estimate')
          }
          value={formatUsageCost(totals.apiEquivalentCostUsd)}
          icon={<Coins className="size-4" />}
        />
        <StatCard
          label={translate('stats.usage.days', 'Recorded days')}
          value={hasRows ? days.size.toLocaleString(getIntlLocale()) : '—'}
          icon={<CalendarDays className="size-4" />}
        />
        <StatCard
          label={translate('stats.usage.cache.title', 'Cache read share of input')}
          value={formatCacheReadShare(
            totals,
            getIntlLocale(),
            translate('stats.usage.format.notAvailable', 'n/a')
          )}
          icon={<DatabaseZap className="size-4" />}
        />
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer text-foreground">
            {translate('stats.usage.estimate.calculation', 'How these figures are calculated')}
          </summary>
          <div className="space-y-1 pt-2">
            <p>
              {translate(
                'stats.usage.estimate.explanation',
                'Dollar amounts are API-equivalent estimates from token logs, not subscription charges or billed spend. Unavailable model prices are excluded; OpenCode cost telemetry and Muse pricing are not treated as billing sources.'
              )}
            </p>
            {totals.unpricedTokens > 0 ? (
              <p>
                {translate(
                  'stats.usage.estimate.unpriced',
                  '{{tokens}} tokens have no API price estimate.',
                  { tokens: totals.unpricedTokens.toLocaleString(getIntlLocale()) }
                )}
              </p>
            ) : null}
            <p>
              {translate(
                'stats.usage.cache.explanation',
                'Cache share = cache read / (new input + cache read + cache write). Cached input is included once; reasoning is already included in output.'
              )}
            </p>
          </div>
        </details>
        <p data-testid="usage-history-coverage">
          {translate(
            'stats.usage.coverage.counts',
            'Recorded coverage: {{providers}} providers · {{models}} models · {{projects}} projects · {{days}} days.',
            {
              providers: new Set(rows.map((row) => row.provider)).size,
              models: new Set(rows.map((row) => row.model).filter((model) => model !== null)).size,
              projects: new Set(rows.map((row) => row.projectKey)).size,
              days: days.size
            }
          )}
        </p>
        {unattributed.length > 0 ? (
          <p data-testid="usage-history-account-coverage">
            {translate(
              'stats.usage.account.coverage',
              '{{tokens}} tokens across {{rows}} rows have unknown account ownership and are excluded from named-account totals. Shared history and older records cannot be assigned from the current login.',
              {
                tokens: totalUsageHistory(unattributed).totalTokens.toLocaleString(getIntlLocale()),
                rows: unattributed.length.toLocaleString(getIntlLocale())
              }
            )}
          </p>
        ) : null}
        {hasCoverageGap ? (
          <p>
            {translate(
              'stats.usage.coverage.partial',
              'Coverage is incomplete. Disabled, unavailable or failed sources do not mean zero usage; totals include recorded rows only.'
            )}
          </p>
        ) : null}
      </div>
      <div
        className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4"
        data-testid="usage-history-sources"
      >
        {sources.map((source) => (
          <div
            key={source.provider}
            className="min-w-0 space-y-1 rounded-md border border-border p-3 text-xs"
          >
            <span className="font-medium text-foreground">
              {PROVIDERS.find((provider) => provider.value === source.provider)?.label}
            </span>
            <p className="text-muted-foreground">
              {source.status === 'unsupported'
                ? translate(
                    'stats.usage.source.ownerUnsupported',
                    'History unavailable on this host'
                  )
                : source.status === 'loading'
                  ? translate('stats.usage.source.loading', 'Loading scan state…')
                  : source.status === 'error'
                    ? translate('stats.usage.source.failed', 'Historical source unavailable')
                    : !source.enabled
                      ? translate('stats.usage.source.disabled', 'Tracking disabled')
                      : source.isScanning || isRefreshing
                        ? translate('stats.usage.source.scanning', 'Scanning logs…')
                        : source.lastScanCompletedAt === null
                          ? translate('stats.usage.source.neverScanned', 'Not scanned yet')
                          : translate('stats.usage.source.updated', 'Scanned {{time}}', {
                              time: new Date(source.lastScanCompletedAt).toLocaleString(
                                getIntlLocale()
                              )
                            })}
            </p>
            {source.needsRescan ? (
              <p className="text-muted-foreground">
                {translate(
                  'stats.usage.source.needsRescan',
                  'Saved totals need a new scan before they can be included. Refresh to rebuild history from available logs.'
                )}
              </p>
            ) : null}
            {source.error ? (
              <p role="status" className="break-words text-destructive">
                {source.error}
              </p>
            ) : null}
            {!source.enabled && source.status === 'ready' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={isRefreshing}
                onClick={() => {
                  recordFeatureInteraction('usage-tracking')
                  void enable(source.provider)
                }}
              >
                {translate('stats.usage.source.enable', 'Enable {{provider}}', {
                  provider:
                    PROVIDERS.find((provider) => provider.value === source.provider)?.label ??
                    source.provider
                })}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {!hasRows ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
          {!hasSupportedSource && !isRefreshing
            ? translate(
                'stats.usage.history.ownerUnavailable',
                'Historical usage is unavailable from {{host}}. Check the host connection and update it if it does not support historical usage.',
                { host: ownerLabel }
              )
            : translate(
                'stats.usage.history.empty',
                'No recorded usage matches this selection. Enable a provider, refresh its scan, or change the filters.'
              )}
        </p>
      ) : (
        <>
          <UsageHistoryDailyChart
            rows={rows}
            range={selection.range}
            selectedDay={selection.day}
            today={today}
            onDay={(day) => setSelection((current) => ({ ...current, day }))}
          />
          <UsageHistoryBreakdowns
            rows={rows}
            onModel={(model) => setSelection((current) => ({ ...current, model }))}
            onProject={(project) => setSelection((current) => ({ ...current, project }))}
            onAccount={(account) => setSelection((current) => ({ ...current, account }))}
            accountLabels={accountLabels}
          />
          {totals.sessions === null ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'stats.usage.session.legacy',
                'Some cached rows have no session attribution. Their tokens remain in the ledger; a new scan rebuilds session detail from available logs.'
              )}
            </p>
          ) : null}
          <UsageHistorySessions rows={rows} accountLabels={accountLabels} />
        </>
      )}
    </div>
  )
}
