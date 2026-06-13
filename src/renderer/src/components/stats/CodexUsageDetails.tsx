import type {
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageSessionRow,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { CodexUsageRecentSessionsTable } from './CodexUsageRecentSessionsTable'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { translate } from '@/i18n/i18n'

type CodexUsageDetailsProps = {
  daily: CodexUsageDailyPoint[]
  modelBreakdown: CodexUsageBreakdownRow[]
  projectBreakdown: CodexUsageBreakdownRow[]
  recentSessions: CodexUsageSessionRow[]
  summary: CodexUsageSummary | null | undefined
}

export function CodexUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: CodexUsageDetailsProps): React.JSX.Element {
  return (
    <>
      <CodexUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.CodexUsagePane.5a0d1d69cd', 'By model')}
          topLabel={translate('auto.components.stats.CodexUsagePane.95d2d89285', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.events,
            hasInferredPricing: row.hasInferredPricing
          }))}
          eventsOrTurns="events"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.CodexUsagePane.b98718aaab', 'By project')}
          topLabel={translate('auto.components.stats.CodexUsagePane.829ee743f2', 'Top project:')}
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

      <CodexUsageRecentSessionsTable recentSessions={recentSessions} />
    </>
  )
}
