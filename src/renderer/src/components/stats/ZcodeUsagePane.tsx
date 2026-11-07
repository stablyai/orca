import { useEffect } from 'react'
import { Activity, Brain, DatabaseZap, FolderKanban, Sigma, Sparkles } from 'lucide-react'
import type { ZcodeUsageRange, ZcodeUsageScope } from '../../../../shared/zcode-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { ZcodeUsageDetails } from './ZcodeUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { getIntlLocale, translate } from '@/i18n/i18n'

// Why: generic labels reuse the OpenCode pane's keys so panes share one translation.
const RANGE_OPTIONS: ZcodeUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: ZcodeUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.ZcodeUsagePane.scopeOrca', 'Orca workspaces only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.ZcodeUsagePane.scopeAll', 'All local ZCode usage')
    }
  }
]
const RANGE_LABELS: Record<ZcodeUsageRange, string> = {
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

export function ZcodeUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.zcodeUsageScanState)
  const summary = useAppStore((state) => state.zcodeUsageSummary)
  const daily = useAppStore((state) => state.zcodeUsageDaily)
  const modelBreakdown = useAppStore((state) => state.zcodeUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.zcodeUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.zcodeUsageRecentSessions)
  const scope = useAppStore((state) => state.zcodeUsageScope)
  const range = useAppStore((state) => state.zcodeUsageRange)
  const fetchZcodeUsage = useAppStore((state) => state.fetchZcodeUsage)
  const setZcodeUsageEnabled = useAppStore((state) => state.setZcodeUsageEnabled)
  const refreshZcodeUsage = useAppStore((state) => state.refreshZcodeUsage)
  const setZcodeUsageScope = useAppStore((state) => state.setZcodeUsageScope)
  const setZcodeUsageRange = useAppStore((state) => state.setZcodeUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchZcodeUsage()
  }, [fetchZcodeUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setZcodeUsageEnabled(enabled)
  }

  const title = translate('auto.components.stats.ZcodeUsagePane.title', 'ZCode Usage Tracking')
  const enableLabel = translate(
    'auto.components.stats.ZcodeUsagePane.enableLabel',
    'Enable ZCode usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        title={title}
        disabledDescription={translate(
          'auto.components.stats.ZcodeUsagePane.disabledDescription',
          'Reads the local ZCode CLI usage database to show token, model, and session stats.'
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
        summaryCardCount={7}
        summaryGridClassName="md:grid-cols-3"
      />
    )
  }

  const hasAnyData = summary?.hasAnyZcodeData ?? scanState.hasAnyZcodeData

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
        'auto.components.stats.ZcodeUsagePane.optionsLabel',
        'ZCode usage options'
      )}
      filtersLabel={translate('auto.components.stats.OpenCodeUsagePane.01583b30aa', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.ZcodeUsagePane.refreshAriaLabel',
        'Refresh ZCode usage'
      )}
      refreshLabel={translate('auto.components.stats.OpenCodeUsagePane.603cd138dc', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.OpenCodeUsagePane.40d283c837', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setZcodeUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setZcodeUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={translate(
        'auto.components.stats.ZcodeUsagePane.emptyMessage',
        'No local ZCode usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshZcodeUsage()}
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
            label={translate(
              'auto.components.stats.ZcodeUsagePane.cacheReadInput',
              'Cache read input'
            )}
            value={formatTokens(summary?.cacheReadInputTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.ZcodeUsagePane.cacheWriteInput',
              'Cache write input'
            )}
            value={formatTokens(summary?.cacheWriteInputTokens ?? 0)}
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
            value={`${(summary?.sessions ?? 0).toLocaleString(getIntlLocale())} / ${(summary?.events ?? 0).toLocaleString(getIntlLocale())}`}
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
            'auto.components.stats.ZcodeUsagePane.noCostNote',
            'The ZCode usage database records tokens but not cost, so no cost estimate is shown.'
          )}
        </p>

        <ZcodeUsageDetails
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
