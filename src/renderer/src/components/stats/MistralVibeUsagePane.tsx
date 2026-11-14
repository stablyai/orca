import { usageFailureMessage } from './usage-failure-message'
import { useUsageObservation } from '../../store/slices/usage/use-usage-observation'
import { Activity, Coins, DatabaseZap, FolderKanban, Sigma, Sparkles } from 'lucide-react'
import type {
  MistralVibeUsageRange,
  MistralVibeUsageScope
} from '../../../../shared/mistral-vibe-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { MistralVibeUsageDetails } from './MistralVibeUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatCost, formatTokens, formatUpdatedAt } from './usage-formatters'
import { unpricedCostLabel } from './unpriced-cost-label'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

// Why: generic labels reuse the OpenCode pane's keys so both panes share one translation.
const RANGE_OPTIONS: MistralVibeUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: MistralVibeUsageScope; label: string }[] = [
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
        'auto.components.stats.MistralVibeUsagePane.scopeAll',
        'All local Mistral Vibe usage'
      )
    }
  }
]
const RANGE_LABELS: Record<MistralVibeUsageRange, string> = {
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

export function MistralVibeUsagePane(): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const scanState = useAppStore((state) => state.mistralVibeUsageScanState)
  const failure = useAppStore((state) => state.mistralVibeUsageFailure)
  const failureMessage = usageFailureMessage(failure, t)
  const summary = useAppStore((state) => state.mistralVibeUsageSummary)
  const daily = useAppStore((state) => state.mistralVibeUsageDaily)
  const modelBreakdown = useAppStore((state) => state.mistralVibeUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.mistralVibeUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.mistralVibeUsageRecentSessions)
  const scope = useAppStore((state) => state.mistralVibeUsageScope)
  const range = useAppStore((state) => state.mistralVibeUsageRange)
  const observeMistralVibeUsage = useAppStore((state) => state.observeMistralVibeUsage)
  const setMistralVibeUsageEnabled = useAppStore((state) => state.setMistralVibeUsageEnabled)
  const refreshMistralVibeUsage = useAppStore((state) => state.refreshMistralVibeUsage)
  const setMistralVibeUsageScope = useAppStore((state) => state.setMistralVibeUsageScope)
  const setMistralVibeUsageRange = useAppStore((state) => state.setMistralVibeUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useUsageObservation(observeMistralVibeUsage)

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setMistralVibeUsageEnabled(enabled)
  }

  const title = t('auto.components.stats.MistralVibeUsagePane.title', 'Mistral Vibe Usage Tracking')
  const enableLabel = t(
    'auto.components.stats.MistralVibeUsagePane.enableLabel',
    'Enable Mistral Vibe usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        failure={failureMessage}
        stateKnown={scanState !== null}
        retry={{ label: t('usage.failure.retry', 'Refresh'), onRefresh: refreshMistralVibeUsage }}
        title={title}
        disabledDescription={t(
          'auto.components.stats.MistralVibeUsagePane.disabledDescription',
          "Reads Vibe's local session catalog to show token, model, and cost stats."
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

  const hasAnyData = summary?.hasAnyMistralVibeData ?? scanState.hasAnyMistralVibeData
  const costCardLabel = unpricedCostLabel(
    t('auto.components.stats.CodexUsagePane.1a18fbd56b', 'Est. API-equivalent cost'),
    summary,
    t
  )

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
        'auto.components.stats.MistralVibeUsagePane.optionsLabel',
        'Mistral Vibe usage options'
      )}
      filtersLabel={t('auto.components.stats.OpenCodeUsagePane.01583b30aa', 'Filters')}
      refreshAriaLabel={t(
        'auto.components.stats.MistralVibeUsagePane.refreshAriaLabel',
        'Refresh Mistral Vibe usage'
      )}
      refreshLabel={t('auto.components.stats.OpenCodeUsagePane.603cd138dc', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={t('auto.components.stats.OpenCodeUsagePane.40d283c837', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setMistralVibeUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={t('auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setMistralVibeUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={t(
        'auto.components.stats.MistralVibeUsagePane.emptyMessage',
        'No local Mistral Vibe usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshMistralVibeUsage()}
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
            label={t('auto.components.stats.OpenCodeUsagePane.7e9433469a', 'Sessions / Events')}
            value={`${(summary?.sessions ?? 0).toLocaleString(intlLocale)} / ${(summary?.events ?? 0).toLocaleString(intlLocale)}`}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={t('auto.components.stats.UsageOverviewPane.3887b94ce5', 'Total tokens')}
            value={formatTokens(summary?.totalTokens ?? 0, intlLocale)}
            icon={<Sigma className="size-4" />}
          />
          <StatCard
            label={costCardLabel}
            value={formatCost(summary?.estimatedCostUsd ?? null)}
            icon={<Coins className="size-4" />}
          />
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          {t(
            'auto.components.stats.MistralVibeUsagePane.costNote',
            'Cost uses the per-model prices in your Vibe config.toml; models without prices are excluded.'
          )}
        </p>

        <MistralVibeUsageDetails
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
