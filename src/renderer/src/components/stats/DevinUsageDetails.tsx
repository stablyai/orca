import type {
  DevinUsageBreakdownRow,
  DevinUsageDailyPoint,
  DevinUsageSessionRow,
  DevinUsageSummary
} from '../../../../shared/devin-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { translate } from '@/i18n/i18n'

type DevinUsageDetailsProps = {
  daily: DevinUsageDailyPoint[]
  modelBreakdown: DevinUsageBreakdownRow[]
  projectBreakdown: DevinUsageBreakdownRow[]
  recentSessions: DevinUsageSessionRow[]
  summary: DevinUsageSummary | null | undefined
}

export function DevinUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: DevinUsageDetailsProps): React.JSX.Element {
  return (
    <>
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
            eventsOrTurns: row.events,
            estimatedCostUsd: row.estimatedCostUsd,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens
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
            eventsOrTurns: row.events,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens
          }))}
          eventsOrTurns="events"
        />
      </div>

      <UsageRecentSessionsTable
        title={translate('auto.components.stats.DevinUsagePane.recentSessions', 'Recent sessions')}
        description={translate(
          'auto.components.stats.DevinUsagePane.recentSessionsDesc',
          'Most recent local Devin sessions in this scope.'
        )}
        headings={[
          translate('auto.components.stats.DevinUsagePane.lastActive', 'Last active'),
          translate('auto.components.stats.DevinUsagePane.project', 'Project'),
          translate('auto.components.stats.DevinUsagePane.model', 'Model'),
          translate('auto.components.stats.DevinUsagePane.events', 'Events'),
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
  )
}
