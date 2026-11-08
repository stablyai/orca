import type {
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  return (
    <>
      <CodexUsageDailyChart daily={daily} reasoningIncludedInOutput={false} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={t('auto.components.stats.OpenCodeUsagePane.040c044d39', 'By model')}
          topLabel={t('auto.components.stats.OpenCodeUsagePane.a15206a63a', 'Top model:')}
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
          title={t('auto.components.stats.OpenCodeUsagePane.0f0a1684bb', 'By project')}
          topLabel={t('auto.components.stats.OpenCodeUsagePane.048ffe4d65', 'Top project:')}
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
        title={t('auto.components.stats.OpenCodeUsagePane.4799177b1c', 'Recent sessions')}
        description={t(
          'auto.components.stats.OpenCodeUsagePane.81817a641a',
          'Most recent local OpenCode sessions in this scope.'
        )}
        headings={[
          t('auto.components.stats.OpenCodeUsagePane.d97bdf6e27', 'Last active'),
          t('auto.components.stats.OpenCodeUsagePane.a4738de041', 'Project'),
          t('auto.components.stats.OpenCodeUsagePane.08c78441b7', 'Model'),
          t('auto.components.stats.OpenCodeUsagePane.d416f5cf92', 'Events'),
          t('auto.components.stats.OpenCodeUsagePane.0f2f266c9d', 'Input'),
          t('auto.components.stats.OpenCodeUsagePane.dfc4513657', 'Output'),
          t('auto.components.stats.OpenCodeUsagePane.349f7c3f5c', 'Total')
        ]}
        unknownModel={t('auto.components.stats.OpenCodeUsagePane.362231082f', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.events}
        getTrailingTokens={(row) => row.totalTokens}
      />
    </>
  )
}
