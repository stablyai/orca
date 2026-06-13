import type {
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { ClaudeUsageRecentSessionsTable } from './ClaudeUsageRecentSessionsTable'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { translate } from '@/i18n/i18n'

type ClaudeUsageDetailsProps = {
  daily: ClaudeUsageDailyPoint[]
  modelBreakdown: ClaudeUsageBreakdownRow[]
  projectBreakdown: ClaudeUsageBreakdownRow[]
  recentSessions: ClaudeUsageSessionRow[]
  summary: ClaudeUsageSummary | null | undefined
}

export function ClaudeUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: ClaudeUsageDetailsProps): React.JSX.Element {
  return (
    <>
      <ClaudeUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.ClaudeUsagePane.0f394c24e3', 'By model')}
          topLabel={translate('auto.components.stats.ClaudeUsagePane.c3fdbc5474', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.inputTokens + row.outputTokens,
            sessions: row.sessions,
            eventsOrTurns: row.turns
          }))}
          eventsOrTurns="turns"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.ClaudeUsagePane.7dc9e5613b', 'By project')}
          topLabel={translate('auto.components.stats.ClaudeUsagePane.f97435845c', 'Top project:')}
          topValue={summary?.topProject}
          rows={projectBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.inputTokens + row.outputTokens,
            sessions: row.sessions,
            eventsOrTurns: row.turns
          }))}
          eventsOrTurns="turns"
        />
      </div>

      <ClaudeUsageRecentSessionsTable recentSessions={recentSessions} summary={summary ?? null} />
    </>
  )
}
