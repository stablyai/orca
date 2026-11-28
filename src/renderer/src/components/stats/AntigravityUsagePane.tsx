import { usageFailureMessage } from './usage-failure-message'
import { useUsageObservation } from '../../store/slices/usage/use-usage-observation'
import { Activity, Brain, DatabaseZap, FolderKanban, Sigma, Sparkles } from 'lucide-react'
import type {
  AntigravityUsageRange,
  AntigravityUsageScope
} from '../../../../shared/agent-usage/analytics/antigravity-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { AntigravityUsageDetails } from './AntigravityUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

// Generic labels reuse the OpenCode pane's keys so provider panes share one translation.
const RANGE_OPTIONS: AntigravityUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: AntigravityUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.OpenCodeUsagePane.e04c58327c', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate(
        'auto.components.stats.AntigravityUsagePane.scopeAll',
        'All local Antigravity usage'
      )
    }
  }
]
const RANGE_LABELS: Record<AntigravityUsageRange, string> = {
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

export function AntigravityUsagePane(): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const scanState = useAppStore((state) => state.antigravityUsageScanState)
  const failure = useAppStore((state) => state.antigravityUsageFailure)
  const failureMessage = usageFailureMessage(failure, t)
  const summary = useAppStore((state) => state.antigravityUsageSummary)
  const daily = useAppStore((state) => state.antigravityUsageDaily)
  const modelBreakdown = useAppStore((state) => state.antigravityUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.antigravityUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.antigravityUsageRecentSessions)
  const scope = useAppStore((state) => state.antigravityUsageScope)
  const range = useAppStore((state) => state.antigravityUsageRange)
  const observeAntigravityUsage = useAppStore((state) => state.observeAntigravityUsage)
  const setAntigravityUsageEnabled = useAppStore((state) => state.setAntigravityUsageEnabled)
  const refreshAntigravityUsage = useAppStore((state) => state.refreshAntigravityUsage)
  const setAntigravityUsageScope = useAppStore((state) => state.setAntigravityUsageScope)
  const setAntigravityUsageRange = useAppStore((state) => state.setAntigravityUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useUsageObservation(observeAntigravityUsage)

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setAntigravityUsageEnabled(enabled)
  }

  const title = t('auto.components.stats.AntigravityUsagePane.title', 'Antigravity Usage Tracking')
  const enableLabel = t(
    'auto.components.stats.AntigravityUsagePane.enableLabel',
    'Enable Antigravity usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        failure={failureMessage}
        stateKnown={scanState !== null}
        retry={{ label: t('usage.failure.retry', 'Refresh'), onRefresh: refreshAntigravityUsage }}
        title={title}
        disabledDescription={t(
          'auto.components.stats.AntigravityUsagePane.disabledDescription',
          'Reads local Antigravity session transcripts to show token, model, and session stats.'
        )}
        enableLabel={enableLabel}
        onEnabledChange={handleSetEnabled}
      />
    )
  }

  if (
    !failureMessage &&
    !summary &&
    (scanState.isScanning || scanState.lastScanCompletedAt === null)
  ) {
    return (
      <ClaudeUsageLoadingState
        title={title}
        summaryCardCount={6}
        summaryGridClassName="md:grid-cols-3"
      />
    )
  }

  const hasAnyData = summary?.hasAnyAntigravityData ?? scanState.hasAnyAntigravityData

  return (
    <UsageTrackingPaneShell
      enabled
      failure={failureMessage}
      title={title}
      status={
        <>
          {formatUpdatedAt(scanState.lastScanCompletedAt, t, intlLocale)}
          {scanState.lastScanError
            ? t(
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
      optionsLabel={t(
        'auto.components.stats.AntigravityUsagePane.optionsLabel',
        'Antigravity usage options'
      )}
      filtersLabel={t('auto.components.stats.OpenCodeUsagePane.01583b30aa', 'Filters')}
      refreshAriaLabel={t(
        'auto.components.stats.AntigravityUsagePane.refreshAriaLabel',
        'Refresh Antigravity usage'
      )}
      refreshLabel={t('auto.components.stats.OpenCodeUsagePane.603cd138dc', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={t('auto.components.stats.OpenCodeUsagePane.40d283c837', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setAntigravityUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={t('auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setAntigravityUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={t(
        'auto.components.stats.AntigravityUsagePane.emptyMessage',
        'No local Antigravity usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshAntigravityUsage()}
    >
      <>
        <div className="grid gap-3 md:grid-cols-3">
          <StatCard
            label={t('auto.components.stats.OpenCodeUsagePane.d637a892ed', 'Input tokens')}
            value={formatTokens(summary?.inputTokens ?? 0, intlLocale)}
            icon={<Sparkles className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.OpenCodeUsagePane.7aa4d8ce35', 'Output tokens')}
            value={formatTokens(summary?.outputTokens ?? 0, intlLocale)}
            icon={<Activity className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.OpenCodeUsagePane.603504ee3b', 'Cached input')}
            value={formatTokens(summary?.cachedInputTokens ?? 0, intlLocale)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.OpenCodeUsagePane.5a65d68b77', 'Reasoning output')}
            value={formatTokens(summary?.reasoningOutputTokens ?? 0, intlLocale)}
            icon={<Brain className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.OpenCodeUsagePane.7e9433469a', 'Sessions / Events')}
            value={`${(summary?.sessions ?? 0).toLocaleString(intlLocale)} / ${(summary?.events ?? 0).toLocaleString(intlLocale)}`}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.UsageOverviewPane.3887b94ce5', 'Total tokens')}
            value={formatTokens(summary?.totalTokens ?? 0, intlLocale)}
            icon={<Sigma className="size-4" />}
          />
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          {t(
            'auto.components.stats.AntigravityUsagePane.noCostNote',
            'Antigravity session transcripts record tokens but not cost, so no cost estimate is shown.'
          )}
        </p>

        <AntigravityUsageDetails
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
