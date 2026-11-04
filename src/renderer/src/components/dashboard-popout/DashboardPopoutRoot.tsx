import { useAppMenuPaste } from '@/hooks/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/useAppMenuSelectionActions'
import { useLargeTextControlPaste } from '@/hooks/useLargeTextControlPaste'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { useDashboardSnapshot } from './useDashboardSnapshot'
import { useAgentDashboardTelemetry } from './use-agent-dashboard-telemetry'

export function DashboardPopoutRoot(): React.JSX.Element {
  // The pop-out has no App shell to translate Edit-menu IPC into terminal ownership events.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useLargeTextControlPaste()
  useAgentDashboardTelemetry('popout')
  const snapshot = useDashboardSnapshot()
  return <AgentKanbanBoard snapshot={snapshot} />
}
