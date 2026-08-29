import type {
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageSessionRow,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
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

      <UsageRecentSessionsTable
        title={translate('auto.components.stats.CodexUsagePane.0cb0983c07', 'Recent sessions')}
        description={translate(
          'auto.components.stats.CodexUsagePane.0bd8655475',
          'Most recent local Codex sessions in this scope.'
        )}
        headings={[
          translate('auto.components.stats.CodexUsagePane.0c36b100be', 'Last active'),
          translate('auto.components.stats.CodexUsagePane.1a65900aea', 'Project'),
          translate('auto.components.stats.CodexUsagePane.c2478bcc3c', 'Model'),
          translate('auto.components.stats.CodexUsagePane.bd0822ca47', 'Events'),
          translate('auto.components.stats.CodexUsagePane.3acc582214', 'Input'),
          translate('auto.components.stats.CodexUsagePane.bbd20344b8', 'Output'),
          translate('auto.components.stats.CodexUsagePane.e0b988599d', 'Total')
        ]}
        unknownModel={translate('auto.components.stats.CodexUsagePane.bf6cf2d4dd', 'Unknown')}
        rows={recentSessions}
        getActivity={(row) => row.events}
        getTrailingTokens={(row) => row.totalTokens}
        getModelSuffix={(row) => (row.hasInferredPricing ? ' *' : '')}
      />
    </>
  )
}
