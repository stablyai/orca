import { useMemo } from 'react'
import { useAppMenuPaste } from '@/hooks/clipboard/menu/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/app-commands/useAppMenuSelectionActions'
import { AgentKanbanBoard } from '../dashboard/board/AgentKanbanBoard'
import { PopoutDashboardBotAsks } from '../dashboard/bot-asks/DashboardBotAsks'
import { useDashboardSnapshot } from './snapshot/useDashboardSnapshot'
import { useAgentDashboardTelemetry } from '../dashboard/board/use-agent-dashboard-telemetry'

export function DashboardPopoutRoot(): React.JSX.Element {
  // The pop-out has no App shell to translate Edit-menu IPC into terminal ownership events.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useAgentDashboardTelemetry('popout')
  const snapshot = useDashboardSnapshot()
  const botAsks = snapshot.botAsks
  const needsYouExtra = useMemo(
    () =>
      botAsks && botAsks.length > 0
        ? { count: botAsks.length, content: <PopoutDashboardBotAsks asks={botAsks} /> }
        : undefined,
    [botAsks]
  )
  return <AgentKanbanBoard snapshot={snapshot} needsYouExtra={needsYouExtra} />
}
