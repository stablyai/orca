import type {
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { translate } from '@/i18n/i18n'

type OpenCodeUsageDetailsProps = {
  daily: OpenCodeUsageDailyPoint[]
  modelBreakdown: OpenCodeUsageBreakdownRow[]
  projectBreakdown: OpenCodeUsageBreakdownRow[]
  recentSessions: OpenCodeUsageSessionRow[]
  summary: OpenCodeUsageSummary | null | undefined
}

export function OpenCodeUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: OpenCodeUsageDetailsProps): React.JSX.Element {
  return (
    <>
      <CodexUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.OpenCodeUsagePane.040c044d39', 'By model')}
          topLabel={translate('auto.components.stats.OpenCodeUsagePane.a15206a63a', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.events,
            estimatedCostUsd: row.estimatedCostUsd
          }))}
          eventsOrTurns="events"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.OpenCodeUsagePane.0f0a1684bb', 'By project')}
          topLabel={translate('auto.components.stats.OpenCodeUsagePane.048ffe4d65', 'Top project:')}
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
        title={translate('auto.components.stats.OpenCodeUsagePane.4799177b1c', 'Recent sessions')}
        description={translate(
          'auto.components.stats.OpenCodeUsagePane.81817a641a',
          'Most recent local OpenCode sessions in this scope.'
        )}
        headings={[
          translate('auto.components.stats.OpenCodeUsagePane.d97bdf6e27', 'Last active'),
          translate('auto.components.stats.OpenCodeUsagePane.a4738de041', 'Project'),
          translate('auto.components.stats.OpenCodeUsagePane.08c78441b7', 'Model'),
          translate('auto.components.stats.OpenCodeUsagePane.d416f5cf92', 'Events'),
          translate('auto.components.stats.OpenCodeUsagePane.0f2f266c9d', 'Input'),
          translate('auto.components.stats.OpenCodeUsagePane.dfc4513657', 'Output'),
          translate('auto.components.stats.OpenCodeUsagePane.349f7c3f5c', 'Total')
        ]}
        unknownModel={translate('auto.components.stats.OpenCodeUsagePane.362231082f', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.events}
        getTrailingTokens={(row) => row.totalTokens}
      />
    </>
  )
}
