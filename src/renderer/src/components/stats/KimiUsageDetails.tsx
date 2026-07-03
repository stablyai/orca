import type {
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageSessionRow,
  KimiUsageSummary
} from '../../../../shared/kimi-usage-types'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'
import { KimiUsageRecentSessionsTable } from './KimiUsageRecentSessionsTable'
import { UsageBreakdownSection } from './UsageBreakdownSection'
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
  return (
    <>
      <CodexUsageDailyChart daily={daily} />

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdownSection
          title={translate('auto.components.stats.KimiUsagePane.040c044d39', 'By model')}
          topLabel={translate('auto.components.stats.KimiUsagePane.a15206a63a', 'Top model:')}
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
          title={translate('auto.components.stats.KimiUsagePane.0f0a1684bb', 'By project')}
          topLabel={translate('auto.components.stats.KimiUsagePane.048ffe4d65', 'Top project:')}
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
