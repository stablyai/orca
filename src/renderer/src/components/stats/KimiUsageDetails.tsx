import type {
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageSessionRow,
  KimiUsageSummary
} from '../../../../shared/kimi-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { UsageBreakdownSection } from './UsageBreakdownSection'
import { KimiUsageRecentSessionsTable } from './KimiUsageRecentSessionsTable'
import { translate } from '@/i18n/i18n'

type KimiUsageDetailsProps = {
  daily: KimiUsageDailyPoint[]
  modelBreakdown: KimiUsageBreakdownRow[]
  projectBreakdown: KimiUsageBreakdownRow[]
  recentSessions: KimiUsageSessionRow[]
  summary: KimiUsageSummary | null | undefined
}

export function KimiUsageDetails({
  daily,
  modelBreakdown,
  projectBreakdown,
  recentSessions,
  summary
}: KimiUsageDetailsProps): React.JSX.Element {
  // Why: CodexUsageDailyChart expects reasoningOutputTokens; Kimi has none.
  const chartDaily = daily.map((entry) => ({
    ...entry,
    reasoningOutputTokens: 0
  }))

  return (
    <>
      <CodexUsageDailyChart daily={chartDaily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.KimiUsageDetails.byModel', 'By model')}
          topLabel={translate('auto.components.stats.KimiUsageDetails.topModel', 'Top model:')}
          topValue={summary?.topModel}
          rows={modelBreakdown.map((row) => ({
            key: row.key,
            label: row.label,
            tokens: row.totalTokens,
            sessions: row.sessions,
            eventsOrTurns: row.events
          }))}
          eventsOrTurns="events"
        />
        <UsageBreakdownSection
          title={translate('auto.components.stats.KimiUsageDetails.byProject', 'By project')}
          topLabel={translate('auto.components.stats.KimiUsageDetails.topProject', 'Top project:')}
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

      <KimiUsageRecentSessionsTable recentSessions={recentSessions} />
    </>
  )
}
