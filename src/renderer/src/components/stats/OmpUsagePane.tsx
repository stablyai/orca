import { useEffect } from 'react'
import { Activity, Brain, Coins, DatabaseZap, FolderKanban, Sparkles } from 'lucide-react'
import type {
  OmpUsageBreakdownRow,
  OmpUsageRange,
  OmpUsageScope,
  OmpUsageSessionRow
} from '../../../../shared/omp-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatCost, formatSessionTime, formatTokens, formatUpdatedAt } from './usage-formatters'
import { getIntlLocale, translate } from '@/i18n/i18n'

// Why: generic labels reuse the OpenCode pane's keys so every provider pane shares one translation.
const RANGE_OPTIONS: OmpUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: OmpUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.OpenCodeUsagePane.e04c58327c', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.OmpUsagePane.scopeAll', 'All local omp usage')
    }
  }
]
const RANGE_LABELS: Record<OmpUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.OpenCodeUsagePane.rangeLast7Days', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.OpenCodeUsagePane.rangeLast30Days', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.OpenCodeUsagePane.rangeLast90Days', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.OpenCodeUsagePane.rangeAllTime', 'All time')
  }
}

function OmpUsageBreakdown({
  title,
  topLabel,
  topValue,
  rows
}: {
  title: string
  topLabel: string
  topValue: string | null | undefined
  rows: OmpUsageBreakdownRow[]
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">
          {topLabel}{' '}
          {topValue ?? translate('auto.components.stats.OmpUsagePane.notAvailable', 'n/a')}
        </p>
      </div>
      <div className="space-y-2">
        {rows.slice(0, 5).map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-foreground">{row.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatTokens(row.totalTokens)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {translate('auto.components.stats.OmpUsagePane.sessionCount', '{{count}} sessions', {
                count: row.sessions,
                defaultValue_one: '{{count}} session'
              })}{' '}
              • {formatCost(row.costUsd)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function OmpRecentSessions({ rows }: { rows: OmpUsageSessionRow[] }): React.JSX.Element {
  const headings = [
    translate('auto.components.stats.OmpUsagePane.lastActive', 'Last active'),
    translate('auto.components.stats.OpenCodeUsagePane.a4738de041', 'Project'),
    translate('auto.components.stats.OpenCodeUsagePane.08c78441b7', 'Model'),
    translate('auto.components.stats.OpenCodeUsagePane.0f2f266c9d', 'Input'),
    translate('auto.components.stats.OpenCodeUsagePane.dfc4513657', 'Output'),
    translate('auto.components.stats.OpenCodeUsagePane.349f7c3f5c', 'Total'),
    translate('auto.components.stats.OmpUsagePane.cost', 'Cost')
  ]
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.OmpUsagePane.recentSessions', 'Recent sessions')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.OmpUsagePane.recentSessionsDescription',
            'Most recent local omp sessions in this scope.'
          )}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              {headings.map((heading) => (
                <th key={heading} className="px-2 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.sessionId} className="border-b border-border/40 last:border-0">
                <td className="px-2 py-2 text-muted-foreground">
                  {formatSessionTime(row.lastActiveAt)}
                </td>
                <td className="px-2 py-2 text-foreground">{row.projectLabel}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {row.model ??
                    translate('auto.components.stats.OpenCodeUsagePane.362231082f', 'Unknown')}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.inputTokens)}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.totalTokens)}</td>
                <td className="px-2 py-2 text-muted-foreground">{formatCost(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function OmpUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.ompUsageScanState)
  const summary = useAppStore((state) => state.ompUsageSummary)
  const daily = useAppStore((state) => state.ompUsageDaily)
  const modelBreakdown = useAppStore((state) => state.ompUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.ompUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.ompUsageRecentSessions)
  const scope = useAppStore((state) => state.ompUsageScope)
  const range = useAppStore((state) => state.ompUsageRange)
  const fetchOmpUsage = useAppStore((state) => state.fetchOmpUsage)
  const setOmpUsageEnabled = useAppStore((state) => state.setOmpUsageEnabled)
  const refreshOmpUsage = useAppStore((state) => state.refreshOmpUsage)
  const setOmpUsageScope = useAppStore((state) => state.setOmpUsageScope)
  const setOmpUsageRange = useAppStore((state) => state.setOmpUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchOmpUsage()
  }, [fetchOmpUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setOmpUsageEnabled(enabled)
  }

  const title = translate('auto.components.stats.OmpUsagePane.title', 'omp Usage Tracking')
  const enableLabel = translate(
    'auto.components.stats.OmpUsagePane.enableLabel',
    'Enable omp usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        title={title}
        disabledDescription={translate(
          'auto.components.stats.OmpUsagePane.disabledDescription',
          'Reads local omp session logs to show token, model, and session stats.'
        )}
        enableLabel={enableLabel}
        onEnabledChange={handleSetEnabled}
      />
    )
  }

  if (!summary && (scanState.isScanning || scanState.lastScanCompletedAt === null)) {
    return (
      <ClaudeUsageLoadingState
        title={title}
        summaryCardCount={6}
        summaryGridClassName="md:grid-cols-3"
      />
    )
  }

  // The corpus-wide daily series stays meaningful even when the scoped summary has no sessions,
  // so the pane keeps its chart whenever either source has data (CodeRabbit #3).
  const hasAnyData =
    (summary?.hasAnyOmpData ?? scanState.hasAnyOmpData ?? false) || daily.length > 0

  return (
    <UsageTrackingPaneShell
      enabled
      title={title}
      status={
        <>
          {formatUpdatedAt(scanState.lastScanCompletedAt)}
          {scanState.lastScanError
            ? translate(
                'auto.components.stats.OpenCodeUsagePane.6cc7782458',
                ' • Last scan error: {{value0}}',
                { value0: scanState.lastScanError }
              )
            : ''}
        </>
      }
      isRefreshing={scanState.isScanning}
      hasData={hasAnyData}
      enableLabel={enableLabel}
      optionsLabel={translate(
        'auto.components.stats.OmpUsagePane.optionsLabel',
        'omp usage options'
      )}
      filtersLabel={translate('auto.components.stats.OpenCodeUsagePane.01583b30aa', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.OmpUsagePane.refreshAriaLabel',
        'Refresh omp usage'
      )}
      refreshLabel={translate('auto.components.stats.OpenCodeUsagePane.603cd138dc', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.OpenCodeUsagePane.40d283c837', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setOmpUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setOmpUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={translate(
        'auto.components.stats.OmpUsagePane.emptyMessage',
        'No local omp usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshOmpUsage()}
    >
      <>
        <div className="grid gap-3 md:grid-cols-3">
          <StatCard
            label={translate('auto.components.stats.OpenCodeUsagePane.d637a892ed', 'Input tokens')}
            value={formatTokens(summary?.inputTokens ?? 0)}
            icon={<Sparkles className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.OpenCodeUsagePane.7aa4d8ce35', 'Output tokens')}
            value={formatTokens(summary?.outputTokens ?? 0)}
            icon={<Activity className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.OpenCodeUsagePane.603504ee3b', 'Cached input')}
            value={formatTokens(summary?.cacheReadTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.OpenCodeUsagePane.5a65d68b77',
              'Reasoning output'
            )}
            value={formatTokens(summary?.reasoningTokens ?? 0)}
            icon={<Brain className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.OmpUsagePane.sessions', 'Sessions')}
            value={(summary?.sessions ?? 0).toLocaleString(getIntlLocale())}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.OmpUsagePane.cost', 'Cost')}
            value={formatCost(summary?.costUsd ?? 0)}
            icon={<Coins className="size-4" />}
          />
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.OmpUsagePane.tokenAccountingNote',
            'Reasoning tokens are shown separately and never count toward output totals. Cache writes are tracked apart from cache reads.'
          )}
        </p>

        <p className="px-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.OmpUsagePane.dailyScopeCaption',
            'Daily totals cover all local omp usage; scope applies to sessions, breakdowns and recent sessions.'
          )}
        </p>

        <CodexUsageDailyChart
          daily={daily.map((point) => ({
            day: point.day,
            // omp's inputTokens is already uncached; codex's chart subtracts cachedInputTokens
            // from inputTokens, so folding cache reads into that field would zero the input
            // segment (CodeRabbit #2). Cache writes join the cached segment instead.
            inputTokens: point.inputTokens,
            cachedInputTokens: point.cacheReadTokens + point.cacheWriteTokens,
            outputTokens: point.outputTokens,
            // Resolution 8: reasoning stays out of the stack; the caption and cards carry it.
            reasoningOutputTokens: 0,
            totalTokens: point.totalTokens
          }))}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          <OmpUsageBreakdown
            title={translate('auto.components.stats.OpenCodeUsagePane.040c044d39', 'By model')}
            topLabel={translate('auto.components.stats.OpenCodeUsagePane.a15206a63a', 'Top model:')}
            topValue={summary?.topModel}
            rows={modelBreakdown}
          />
          <OmpUsageBreakdown
            title={translate('auto.components.stats.OpenCodeUsagePane.0f0a1684bb', 'By project')}
            topLabel={translate(
              'auto.components.stats.OpenCodeUsagePane.048ffe4d65',
              'Top project:'
            )}
            topValue={summary?.topProject}
            rows={projectBreakdown}
          />
        </div>

        <OmpRecentSessions rows={recentSessions} />
      </>
    </UsageTrackingPaneShell>
  )
}
