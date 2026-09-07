import type {
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
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

      <UsageRecentSessionsTable
        title={translate('auto.components.stats.ClaudeUsagePane.7e76c84153', 'Recent sessions')}
        description={
          <>
            {translate('auto.components.stats.ClaudeUsagePane.abfc4a4943', 'Cache reuse rate:')}{' '}
            {summary?.cacheReuseRate !== null && summary?.cacheReuseRate !== undefined
              ? `${Math.round(summary.cacheReuseRate * 100)}%`
              : translate('auto.components.stats.ClaudeUsagePane.7765a4c3e1', 'n/a')}
          </>
        }
        headings={[
          translate('auto.components.stats.ClaudeUsagePane.01476891c7', 'Last active'),
          translate('auto.components.stats.ClaudeUsagePane.c17bed0416', 'Project'),
          translate('auto.components.stats.ClaudeUsagePane.1afc25eb06', 'Model'),
          translate('auto.components.stats.ClaudeUsagePane.0f03975d59', 'Turns'),
          translate('auto.components.stats.ClaudeUsagePane.faf3444859', 'Input'),
          translate('auto.components.stats.ClaudeUsagePane.a8b7487ff7', 'Output'),
          translate('auto.components.stats.ClaudeUsagePane.21ea00bfa8', 'Cache')
        ]}
        unknownModel={translate('auto.components.stats.ClaudeUsagePane.cfe2282ffa', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.turns}
        getTrailingTokens={(row) => row.cacheReadTokens + row.cacheWriteTokens}
      />
    </>
  )
}
