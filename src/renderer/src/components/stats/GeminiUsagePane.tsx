import { useEffect } from 'react'
import { Activity, Brain, Coins, DatabaseZap, FolderKanban, Sparkles } from 'lucide-react'
import type { GeminiUsageRange, GeminiUsageScope } from '../../../../shared/gemini-usage-types'
import { useAppStore } from '../../store'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { GeminiUsageDetails } from './GeminiUsageDetails'
import { StatCard } from './StatCard'
import { UsageFilterRadioGroup, UsageTrackingPaneShell } from './UsageTrackingPaneShell'
import { formatCost, formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const RANGE_OPTIONS: GeminiUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: GeminiUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.GeminiUsagePane.scopeOrca', 'In Orca worktrees')
    }
  },
  {
    value: 'all',
    get label() {
      return translate(
        'auto.components.stats.GeminiUsagePane.scopeAll',
        'All local Gemini & Antigravity sessions'
      )
    }
  }
]
const RANGE_LABELS: Record<GeminiUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.GeminiUsagePane.rangeLast7Days', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.GeminiUsagePane.rangeLast30Days', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.GeminiUsagePane.rangeLast90Days', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.GeminiUsagePane.rangeAllTime', 'All time')
  }
}

export function GeminiUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.geminiUsageScanState)
  const summary = useAppStore((state) => state.geminiUsageSummary)
  const daily = useAppStore((state) => state.geminiUsageDaily)
  const modelBreakdown = useAppStore((state) => state.geminiUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.geminiUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.geminiUsageRecentSessions)
  const scope = useAppStore((state) => state.geminiUsageScope)
  const range = useAppStore((state) => state.geminiUsageRange)
  const fetchGeminiUsage = useAppStore((state) => state.fetchGeminiUsage)
  const setGeminiUsageEnabled = useAppStore((state) => state.setGeminiUsageEnabled)
  const refreshGeminiUsage = useAppStore((state) => state.refreshGeminiUsage)
  const setGeminiUsageScope = useAppStore((state) => state.setGeminiUsageScope)
  const setGeminiUsageRange = useAppStore((state) => state.setGeminiUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchGeminiUsage()
  }, [fetchGeminiUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setGeminiUsageEnabled(enabled)
  }

  const title = translate(
    'auto.components.stats.GeminiUsagePane.title',
    'Gemini & Antigravity Usage Tracking'
  )
  const enableLabel = translate(
    'auto.components.stats.GeminiUsagePane.enableLabel',
    'Enable Gemini usage analytics'
  )

  if (!scanState?.enabled) {
    return (
      <UsageTrackingPaneShell
        enabled={false}
        title={title}
        disabledDescription={translate(
          'auto.components.stats.GeminiUsagePane.disabledDesc',
          'Reads local Gemini CLI and Antigravity logs to show token, model, and session stats.'
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
  const hasAnyData = summary?.hasAnyGeminiData ?? scanState.hasAnyGeminiData

  return (
    <UsageTrackingPaneShell
      enabled
      title={title}
      status={
        <>
          {formatUpdatedAt(scanState.lastScanCompletedAt)}
          {scanState.lastScanError
            ? translate(
                'auto.components.stats.GeminiUsagePane.lastScanError',
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
        'auto.components.stats.GeminiUsagePane.optionsLabel',
        'Gemini usage options'
      )}
      filtersLabel={translate('auto.components.stats.GeminiUsagePane.filters', 'Filters')}
      refreshAriaLabel={translate(
        'auto.components.stats.GeminiUsagePane.refreshAria',
        'Refresh Gemini usage'
      )}
      refreshLabel={translate('auto.components.stats.GeminiUsagePane.refresh', 'Refresh')}
      filterSections={[
        <UsageFilterRadioGroup
          key="scope"
          label={translate('auto.components.stats.GeminiUsagePane.scope', 'Scope')}
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={(value) => void setGeminiUsageScope(value)}
        />,
        <UsageFilterRadioGroup
          key="range"
          label={translate('auto.components.stats.GeminiUsagePane.range', 'Range')}
          value={range}
          options={RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] }))}
          onValueChange={(value) => void setGeminiUsageRange(value)}
        />
      ]}
      selectionSummary={
        <>
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </>
      }
      emptyMessage={translate(
        'auto.components.stats.GeminiUsagePane.emptyMessage',
        'No local Gemini or Antigravity usage found yet for this scope.'
      )}
      onEnabledChange={handleSetEnabled}
      onRefresh={() => void refreshGeminiUsage()}
    >
      <>
        <div className="grid gap-3 md:grid-cols-3">
          <StatCard
            label={translate('auto.components.stats.GeminiUsagePane.inputTokens', 'Input tokens')}
            value={formatTokens(summary?.inputTokens ?? 0)}
            icon={<Sparkles className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.GeminiUsagePane.outputTokens', 'Output tokens')}
            value={formatTokens(summary?.outputTokens ?? 0)}
            icon={<Activity className="size-4" />}
          />
          <StatCard
            label={translate('auto.components.stats.GeminiUsagePane.cachedInput', 'Cached input')}
            value={formatTokens(summary?.cachedInputTokens ?? 0)}
            icon={<DatabaseZap className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.GeminiUsagePane.reasoningOutput',
              'Reasoning output'
            )}
            value={formatTokens(summary?.reasoningOutputTokens ?? 0)}
            icon={<Brain className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.GeminiUsagePane.sessionsEvents',
              'Sessions / Events'
            )}
            value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
            icon={<FolderKanban className="size-4" />}
          />
          <StatCard
            label={translate(
              'auto.components.stats.GeminiUsagePane.estimatedCost',
              'Estimated cost'
            )}
            value={formatCost(summary?.estimatedCostUsd ?? null)}
            icon={<Coins className="size-4" />}
          />
        </div>

        <GeminiUsageDetails
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
