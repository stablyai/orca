import { useAppMenuPaste } from '@/hooks/useAppMenuPaste'
import { useAppMenuSelectionActions } from '@/hooks/useAppMenuSelectionActions'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { useDashboardSnapshot } from './useDashboardSnapshot'

/**
 * Root of the pop-out dashboard window. Subscribes to the live snapshot relayed
 * from the main window and renders the agent board.
 */
export function DashboardPopoutRoot(): React.JSX.Element {
  // Why: this window has no App shell, so nothing else would translate the
  // Edit-menu IPC into the ownership events the terminal preview claims.
  useAppMenuPaste()
  useAppMenuSelectionActions()
  const snapshot = useDashboardSnapshot()
  return <AgentKanbanBoard snapshot={snapshot} />
}
