import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { AgentSubjectReadIntent } from '@/attention/agent-subject-read-actions'
import { revealDashboardAgent } from './navigation/reveal-dashboard-agent'
import { AgentKanbanBoard } from './board/AgentKanbanBoard'
import type { DashboardRevealAgentArgs } from '../../../../shared/agent-status/presentation/dashboard-snapshot'
import { AgentDashboardSettingsMenu } from './settings/AgentDashboardSettingsMenu'
import { useLiveDashboardSnapshot } from './snapshot/useLiveDashboardSnapshot'
import { useAgentDashboardTelemetry } from './board/use-agent-dashboard-telemetry'

const ignoreMenuOpenChange = (): void => {}

/** The board docked as a right sidebar tab: it sits beside the work instead of over it, so reveals keep it open. */
export default function AgentDashboardRightSidebarPanel(): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()
  useAgentDashboardTelemetry('right_sidebar')

  const handleAckAgent = useCallback((paneKey: string, intent: AgentSubjectReadIntent) => {
    useAppStore.getState().acknowledgeAgents([paneKey], undefined, intent)
  }, [])
  const handleRevealAgent = useCallback((args: DashboardRevealAgentArgs) => {
    revealDashboardAgent(args)
  }, [])
  const handleSwitchToPopout = useCallback(() => {
    void window.api.dashboard.openPopout?.()
  }, [])

  return (
    <AgentKanbanBoard
      snapshot={snapshot}
      containerClassName="h-full w-full bg-transparent"
      onAckAgent={handleAckAgent}
      onRevealAgent={handleRevealAgent}
      docked
      headerActions={
        <AgentDashboardSettingsMenu
          onSwitchToPopout={handleSwitchToPopout}
          onOpenChange={ignoreMenuOpenChange}
        />
      }
    />
  )
}
