import { useAppMenuPaste } from '@/hooks/clipboard/menu/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/app-commands/useAppMenuSelectionActions'
import { AgentKanbanBoard } from '../dashboard/board/AgentKanbanBoard'
import { useDashboardSnapshot } from './snapshot/useDashboardSnapshot'
import { useAgentDashboardTelemetry } from '../dashboard/board/use-agent-dashboard-telemetry'

export function DashboardPopoutRoot(): React.JSX.Element {
  // The pop-out has no App shell to translate Edit-menu IPC into terminal ownership events.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useAgentDashboardTelemetry('popout')
  const snapshot = useDashboardSnapshot()
  return <AgentKanbanBoard snapshot={snapshot} />
}
