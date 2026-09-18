import { useEffect } from 'react'
import { Activity, DatabaseZap, FolderKanban, Sparkles } from 'lucide-react'
import type { DevinUsageRange, DevinUsageScope } from '../../../../shared/devin-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { StatCard } from './StatCard'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const RANGES: DevinUsageRange[] = ['7d', '30d', '90d', 'all']
const RANGE_LABELS: Record<DevinUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.DevinUsagePane.range7d', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.DevinUsagePane.range30d', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.DevinUsagePane.range90d', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.DevinUsagePane.rangeAll', 'All time')
  }
}
const SCOPES: { value: DevinUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.DevinUsagePane.orcaScope', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.DevinUsagePane.allScope', 'All local Devin usage')
    }
  }
]

export function DevinUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.devinUsageScanState)
  const summary = useAppStore((state) => state.devinUsageSummary)
  const daily = useAppStore((state) => state.devinUsageDaily)
  const modelBreakdown = useAppStore((state) => state.devinUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.devinUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.devinUsageRecentSessions)
  const scope = useAppStore((state) => state.devinUsageScope)
  const range = useAppStore((state) => state.devinUsageRange)
  const fetchUsage = useAppStore((state) => state.fetchDevinUsage)
  const setEnabled = useAppStore((state) => state.setDevinUsageEnabled)
  const refresh = useAppStore((state) => state.refreshDevinUsage)
  const setScope = useAppStore((state) => state.setDevinUsageScope)
  const setRange = useAppStore((state) => state.setDevinUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => void fetchUsage(), [fetchUsage])
  const onEnabledChange = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setEnabled(enabled)
  }
  const title = translate('auto.components.stats.DevinUsagePane.title', 'Devin Usage Tracking')
  const enableLabel = translate(
    'auto.components.stats.DevinUsagePane.enableLabel',
    'Enable Devin usage analytics'
  )
  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        title={title}
        disabledDescription={translate(
          'auto.components.stats.DevinUsagePane.disabledDescription',
          'Reads local Devin transcripts to show token, model, and session stats.'
        )}
        enableLabel={enableLabel}
        onEnabledChange={onEnabledChange}
      />
    )
  }
  if (!summary && (scanState.isScanning || scanState.lastScanCompletedAt === null)) {
    return (
      <ClaudeUsageLoadingState
        title={title}
        summaryCardCount={4}
        summaryGridClassName="md:grid-cols-2"
      />
    )
  }
  return (
    <UsageTrackingPaneShell
      enabled
      title={title}
      status={`${formatUpdatedAt(scanState.lastScanCompletedAt)}${scanState.lastScanError ? ` • Last scan error: ${scanState.lastScanError}` : ''}`}
      isRefreshing={scanState.isScanning}
      hasData={summary?.hasAnyDevinData ?? scanState.hasAnyDevinData}
      enableLabel={enableLabel}
      optionsLabel={translate(
        'auto.components.stats.DevinUsagePane.optionsLabel',
        'Devin usage options'
      )}
      filtersLabel={translate('auto.components.stats.DevinUsagePane.filters', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.DevinUsagePane.refreshAria',
        'Refresh Devin usage'
      )}
      refreshLabel={translate('auto.components.stats.DevinUsagePane.refresh', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.DevinUsagePane.scope', 'Scope')}
          value={scope}
          options={SCOPES}
          onValueChange={(value) => void setScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.DevinUsagePane.range', 'Range')}
          value={range}
          options={RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setRange(value)}
        />
      ]}
      selectionSummary={`${SCOPES.find((option) => option.value === scope)?.label} • ${RANGE_LABELS[range]}`}
      emptyMessage={translate(
        'auto.components.stats.DevinUsagePane.empty',
        'No local Devin usage found yet for this scope.'
      )}
      onEnabledChange={onEnabledChange}
      onRefresh={() => void refresh()}
    >
      <>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={translate('auto.components.stats.DevinUsagePane.inputTokens', 'Input tokens')}
            value={formatTokens(summary?.inputTokens ?? 0)}
            icon={<Sparkles className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.DevinUsagePane.outputTokens', 'Output tokens')}
            value={formatTokens(summary?.outputTokens ?? 0)}
            icon={<Activity className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.DevinUsagePane.cacheTokens', 'Cache tokens')}
            value={formatTokens(summary?.cachedInputTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.DevinUsagePane.sessionsEvents',
              'Sessions / Events'
            )}
            value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
            icon={<FolderKanban className="size-4" />}
          />
        </div>
        <CodexUsageDailyChart daily={daily} />
        <div className="grid gap-4 xl:grid-cols-2">
          <UsageBreakdownSection
            title={translate('auto.components.stats.DevinUsagePane.byModel', 'By model')}
            topLabel={translate('auto.components.stats.DevinUsagePane.topModel', 'Top model:')}
            topValue={summary?.topModel}
            rows={modelBreakdown.map((row) => ({
              key: row.key,
              label: row.label,
              tokens: row.totalTokens,
              sessions: row.sessions,
              eventsOrTurns: row.events
            }))}
            eventsOrTurns="events"
          />
          <UsageBreakdownSection
            title={translate('auto.components.stats.DevinUsagePane.byProject', 'By project')}
            topLabel={translate('auto.components.stats.DevinUsagePane.topProject', 'Top project:')}
            topValue={summary?.topProject}
            rows={projectBreakdown.map((row) => ({
              key: row.key,
              label: row.label,
              tokens: row.totalTokens,
              sessions: row.sessions,
              eventsOrTurns: row.events
            }))}
            eventsOrTurns="events"
          />
        </div>
        <UsageRecentSessionsTable
          title={translate(
            'auto.components.stats.DevinUsagePane.recentSessions',
            'Recent sessions'
          )}
          description={translate(
            'auto.components.stats.DevinUsagePane.recentDescription',
            'Most recent local Devin sessions in this scope.'
          )}
          headings={[
            translate('auto.components.stats.DevinUsagePane.lastActive', 'Last active'),
            translate('auto.components.stats.DevinUsagePane.project', 'Project'),
            translate('auto.components.stats.DevinUsagePane.model', 'Model'),
            translate('auto.components.stats.DevinUsagePane.eventsTitle', 'Events'),
            translate('auto.components.stats.DevinUsagePane.input', 'Input'),
            translate('auto.components.stats.DevinUsagePane.output', 'Output'),
            translate('auto.components.stats.DevinUsagePane.total', 'Total')
          ]}
          unknownModel={translate('auto.components.stats.DevinUsagePane.unknown', 'Unknown')}
          rows={recentSessions}
          getActivity={(row) => row.events}
          getTrailingTokens={(row) => row.totalTokens}
        />
      </>
    </UsageTrackingPaneShell>
  )
}
