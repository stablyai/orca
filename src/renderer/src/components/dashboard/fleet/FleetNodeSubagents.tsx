import { useTranslate } from '@/i18n/use-translate'
import type { DashboardCardSubagent } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import {
  DASHBOARD_SUBAGENT_ROW_CLASS,
  DashboardSubagentList,
  formatSubagentCount
} from '../board/DashboardSubagentList'

const FLEET_NODE_SUBAGENT_ROWS = 3

export function FleetNodeSubagents({
  subagents
}: {
  subagents: readonly DashboardCardSubagent[]
}): React.JSX.Element {
  const t = useTranslate()
  const hidden = subagents.length - FLEET_NODE_SUBAGENT_ROWS
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className="text-2xs text-muted-foreground">
        {formatSubagentCount(subagents.length, t)}
      </span>
      <DashboardSubagentList subagents={subagents.slice(0, FLEET_NODE_SUBAGENT_ROWS)}>
        {hidden > 0 ? (
          <span className={DASHBOARD_SUBAGENT_ROW_CLASS}>
            {t('dashboardPopout.fleet.moreSubagents', '+{{count}} more', {
              count: hidden,
              defaultValue_one: '+{{count}} more'
            })}
          </span>
        ) : null}
      </DashboardSubagentList>
    </span>
  )
}
