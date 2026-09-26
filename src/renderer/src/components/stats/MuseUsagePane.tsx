import { useEffect } from 'react'
import { Activity, Brain, DatabaseZap, FolderKanban, Sigma, Sparkles } from 'lucide-react'
import type { MuseUsageRange, MuseUsageScope } from '../../../../shared/muse-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { MuseUsageDetails } from './MuseUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

// Why: generic labels reuse the OpenCode pane's keys so both panes share one translation.
const RANGE_OPTIONS: MuseUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: MuseUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.OpenCodeUsagePane.e04c58327c', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.MuseUsagePane.scopeAll', 'All local Muse usage')
    }
  }
]
const RANGE_LABELS: Record<MuseUsageRange, string> = {
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

export function MuseUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.museUsageScanState)
  const summary = useAppStore((state) => state.museUsageSummary)
  const daily = useAppStore((state) => state.museUsageDaily)
  const modelBreakdown = useAppStore((state) => state.museUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.museUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.museUsageRecentSessions)
  const scope = useAppStore((state) => state.museUsageScope)
  const range = useAppStore((state) => state.museUsageRange)
  const fetchMuseUsage = useAppStore((state) => state.fetchMuseUsage)
  const setMuseUsageEnabled = useAppStore((state) => state.setMuseUsageEnabled)
  const refreshMuseUsage = useAppStore((state) => state.refreshMuseUsage)
  const setMuseUsageScope = useAppStore((state) => state.setMuseUsageScope)
  const setMuseUsageRange = useAppStore((state) => state.setMuseUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchMuseUsage()
  }, [fetchMuseUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setMuseUsageEnabled(enabled)
  }

  const title = translate('auto.components.stats.MuseUsagePane.title', 'Muse Usage Tracking')
  const enableLabel = translate(
    'auto.components.stats.MuseUsagePane.enableLabel',
    'Enable Muse usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        title={title}
        disabledDescription={translate(
          'auto.components.stats.MuseUsagePane.disabledDescription',
          'Reads local Muse session logs to show token, model, and session stats.'
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

  const hasAnyData = summary?.hasAnyMuseData ?? scanState.hasAnyMuseData

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
        'auto.components.stats.MuseUsagePane.optionsLabel',
        'Muse usage options'
      )}
      filtersLabel={translate('auto.components.stats.OpenCodeUsagePane.01583b30aa', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.MuseUsagePane.refreshAriaLabel',
        'Refresh Muse usage'
      )}
      refreshLabel={translate('auto.components.stats.OpenCodeUsagePane.603cd138dc', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.OpenCodeUsagePane.40d283c837', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setMuseUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setMuseUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={translate(
        'auto.components.stats.MuseUsagePane.emptyMessage',
        'No local Muse usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshMuseUsage()}
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
            value={formatTokens(summary?.cachedInputTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.OpenCodeUsagePane.5a65d68b77',
              'Reasoning output'
            )}
            value={formatTokens(summary?.reasoningOutputTokens ?? 0)}
            icon={<Brain className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.OpenCodeUsagePane.7e9433469a',
              'Sessions / Events'
            )}
            value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.UsageOverviewPane.3887b94ce5', 'Total tokens')}
            value={formatTokens(summary?.totalTokens ?? 0)}
            icon={<Sigma className="size-4" />}
          />
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.MuseUsagePane.noCostNote',
            'Muse session logs record tokens but not cost, so no cost estimate is shown.'
          )}
        </p>

        <MuseUsageDetails
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
