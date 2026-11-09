import type {
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageSessionRow,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  return (
    <>
      <ClaudeUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={t('auto.components.stats.ClaudeUsagePane.0f394c24e3', 'By model')}
          topLabel={t('auto.components.stats.ClaudeUsagePane.c3fdbc5474', 'Top model:')}
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
          title={t('auto.components.stats.ClaudeUsagePane.7dc9e5613b', 'By project')}
          topLabel={t('auto.components.stats.ClaudeUsagePane.f97435845c', 'Top project:')}
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
        title={t('auto.components.stats.ClaudeUsagePane.7e76c84153', 'Recent sessions')}
        description={
          <>
            {t('auto.components.stats.ClaudeUsagePane.abfc4a4943', 'Cache reuse rate:')}{' '}
            {summary?.cacheReuseRate !== null && summary?.cacheReuseRate !== undefined
              ? `${Math.round(summary.cacheReuseRate * 100)}%`
              : t('auto.components.stats.ClaudeUsagePane.7765a4c3e1', 'n/a')}
          </>
        }
        headings={[
          t('auto.components.stats.ClaudeUsagePane.01476891c7', 'Last active'),
          t('auto.components.stats.ClaudeUsagePane.c17bed0416', 'Project'),
          t('auto.components.stats.ClaudeUsagePane.1afc25eb06', 'Model'),
          t('auto.components.stats.ClaudeUsagePane.0f03975d59', 'Turns'),
          t('auto.components.stats.ClaudeUsagePane.faf3444859', 'Input'),
          t('auto.components.stats.ClaudeUsagePane.a8b7487ff7', 'Output'),
          t('auto.components.stats.ClaudeUsagePane.21ea00bfa8', 'Cache')
        ]}
        unknownModel={t('auto.components.stats.ClaudeUsagePane.cfe2282ffa', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.turns}
        getTrailingTokens={(row) => row.cacheReadTokens + row.cacheWriteTokens}
      />
    </>
  )
}
