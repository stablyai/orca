import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { DashboardCardSubagent } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'

export function formatSubagentCount(count: number, t: Translate = translate): string {
  return t('dashboardPopout.card.subagents', '{{count}} subagents', {
    count,
    defaultValue_one: '{{count}} subagent'
  })
}

export const DASHBOARD_SUBAGENT_ROW_CLASS =
  'flex min-w-0 items-center gap-1.5 py-0.5 text-2xs text-muted-foreground'

export function DashboardSubagentList({
  subagents,
  children
}: {
  subagents: readonly DashboardCardSubagent[]
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="ml-1 flex flex-col gap-1 border-l border-border pl-2">
      {subagents.map((subagent) => (
        <span key={subagent.id} className={DASHBOARD_SUBAGENT_ROW_CLASS}>
          <AgentStateDot state={subagent.dotState} />
          <span className="truncate">{subagent.name}</span>
        </span>
      ))}
      {children}
    </span>
  )
}
