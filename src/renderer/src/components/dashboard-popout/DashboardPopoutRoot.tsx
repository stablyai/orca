import { AgentKanbanBoard } from './AgentKanbanBoard'
import { useDashboardSnapshot } from './useDashboardSnapshot'

/**
 * Root of the pop-out dashboard window. Subscribes to the live snapshot relayed
 * from the main window and renders the agent board.
 */
export function DashboardPopoutRoot(): React.JSX.Element {
  const snapshot = useDashboardSnapshot()
  return <AgentKanbanBoard snapshot={snapshot} />
}
