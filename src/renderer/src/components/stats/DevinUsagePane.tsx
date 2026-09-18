import { useEffect } from 'react'
import { Activity, Brain, DatabaseZap, FolderKanban, Sparkles, Sigma } from 'lucide-react'
import type { DevinUsageRange, DevinUsageScope } from '../../../../shared/devin-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { DevinUsageDetails } from './DevinUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const RANGE_OPTIONS: DevinUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: DevinUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.DevinUsagePane.scopeOrca', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.DevinUsagePane.scopeAll', 'All local Devin usage')
    }
  }
]
const RANGE_LABELS: Record<DevinUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.DevinUsagePane.rangeLast7Days', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.DevinUsagePane.rangeLast30Days', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.DevinUsagePane.rangeLast90Days', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.DevinUsagePane.rangeAllTime', 'All time')
  }
}

export function DevinUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.devinUsageScanState)
  const summary = useAppStore((state) => state.devinUsageSummary)
  const daily = useAppStore((state) => state.devinUsageDaily)
  const modelBreakdown = useAppStore((state) => state.devinUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.devinUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.devinUsageRecentSessions)
  const scope = useAppStore((state) => state.devinUsageScope)
  const range = useAppStore((state) => state.devinUsageRange)
  const fetchDevinUsage = useAppStore((state) => state.fetchDevinUsage)
  const setDevinUsageEnabled = useAppStore((state) => state.setDevinUsageEnabled)
  const refreshDevinUsage = useAppStore((state) => state.refreshDevinUsage)
  const setDevinUsageScope = useAppStore((state) => state.setDevinUsageScope)
  const setDevinUsageRange = useAppStore((state) => state.setDevinUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchDevinUsage()
  }, [fetchDevinUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setDevinUsageEnabled(enabled)
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
          'Reads local Devin CLI transcripts to show token, model, and session stats.'
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

  const hasAnyData = summary?.hasAnyDevinData ?? scanState.hasAnyDevinData

  return (
    <UsageTrackingPaneShell
      enabled
      title={title}
      status={
        <>
          {formatUpdatedAt(scanState.lastScanCompletedAt)}
          {scanState.lastScanError
            ? translate(
                'auto.components.stats.DevinUsagePane.lastScanError',
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
        'auto.components.stats.DevinUsagePane.optionsLabel',
        'Devin usage options'
      )}
      filtersLabel={translate('auto.components.stats.DevinUsagePane.filtersLabel', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.DevinUsagePane.refreshAriaLabel',
        'Refresh Devin usage'
      )}
      refreshLabel={translate('auto.components.stats.DevinUsagePane.refreshLabel', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.DevinUsagePane.scopeLabel', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setDevinUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.DevinUsagePane.rangeLabel', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setDevinUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={translate(
        'auto.components.stats.DevinUsagePane.emptyMessage',
        'No local Devin usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshDevinUsage()}
    >
      <>
        <div className="grid gap-3 md:grid-cols-3">
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
            label={translate('auto.components.stats.DevinUsagePane.cachedInput', 'Cached input')}
            value={formatTokens(summary?.cachedInputTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.DevinUsagePane.reasoningOutput',
              'Reasoning output'
            )}
            value={formatTokens(summary?.reasoningOutputTokens ?? 0)}
            icon={<Brain className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.DevinUsagePane.sessionsEvents',
              'Sessions / Events'
            )}
            value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.DevinUsagePane.totalTokens', 'Total tokens')}
            value={formatTokens(summary?.totalTokens ?? 0)}
            icon={<Sigma className="size-4" />}
          />
        </div>

        <DevinUsageDetails
          daily={daily}
          modelBreakdown={modelBreakdown}
          projectBreakdown={projectBreakdown}
          recentSessions={recentSessions}
          summary={summary}
        />
      </>
    </UsageTrackingPaneShell>
  )
}
