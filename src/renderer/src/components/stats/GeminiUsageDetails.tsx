import type {
  GeminiUsageBreakdownRow,
  GeminiUsageDailyPoint,
  GeminiUsageSessionRow,
  GeminiUsageSummary
} from '../../../../shared/gemini-usage-types'
import { GeminiUsageDailyChart } from './GeminiUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { translate } from '@/i18n/i18n'

type GeminiUsageDetailsProps = {
  daily: GeminiUsageDailyPoint[]
  modelBreakdown: GeminiUsageBreakdownRow[]
  projectBreakdown: GeminiUsageBreakdownRow[]
  recentSessions: GeminiUsageSessionRow[]
  summary: GeminiUsageSummary | null | undefined
}

export function GeminiUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: GeminiUsageDetailsProps): React.JSX.Element {
  return (
    <>
      <GeminiUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.GeminiUsagePane.byModel', 'By model')}
          topLabel={translate('auto.components.stats.GeminiUsagePane.topModel', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.events,
            estimatedCostUsd: row.estimatedCostUsd,
            hasInferredPricing: row.hasInferredPricing
          }))}
          eventsOrTurns="events"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.GeminiUsagePane.byProject', 'By project')}
          topLabel={translate('auto.components.stats.GeminiUsagePane.topProject', 'Top project:')}
          topValue={summary?.topProject}
          rows={projectBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.events,
            estimatedCostUsd: row.estimatedCostUsd,
            hasInferredPricing: row.hasInferredPricing
          }))}
          eventsOrTurns="events"
        />
      </div>

      <UsageRecentSessionsTable
        title={translate('auto.components.stats.GeminiUsagePane.recentSessions', 'Recent sessions')}
        description={translate(
          'auto.components.stats.GeminiUsagePane.recentSessionsDesc',
          'Most recent local Gemini & Antigravity sessions in this scope.'
        )}
        headings={[
          translate('auto.components.stats.GeminiUsagePane.headingLastActive', 'Last active'),
          translate('auto.components.stats.GeminiUsagePane.headingProject', 'Project'),
          translate('auto.components.stats.GeminiUsagePane.headingModel', 'Model'),
          translate('auto.components.stats.GeminiUsagePane.headingEvents', 'Events'),
          translate('auto.components.stats.GeminiUsagePane.headingInput', 'Input'),
          translate('auto.components.stats.GeminiUsagePane.headingOutput', 'Output'),
          translate('auto.components.stats.GeminiUsagePane.headingTotal', 'Total')
        ]}
        unknownModel={translate('auto.components.stats.GeminiUsagePane.unknown', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.events}
        getTrailingTokens={(row) => row.totalTokens}
        getModelSuffix={(row) => (row.hasInferredPricing ? ' *' : '')}
      />
    </>
  )
}
