import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { ZotzAgentQueueDrawer } from './ZotzAgentQueueDrawer'
import {
  setZotzAgentQueueDrawerOpen,
  useZotzAgentQueueDrawerOpen
} from './zotz-agent-queue-drawer-open'

/** The queue board shares the sidebar's companion slot: opening it closes the workspace board and the agents board, and theirs close it. */
export default function ZotzAgentQueueSidebarHost({
  workspaceBoardOpen,
  closeWorkspaceBoard,
  leftSidebarStyle,
  statusBarVisible
}: {
  workspaceBoardOpen: boolean
  closeWorkspaceBoard: () => void
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}): React.JSX.Element {
  const open = useZotzAgentQueueDrawerOpen()
  const agentDashboardOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setAgentDashboardOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  useEffect(() => {
    if (open) {
      closeWorkspaceBoard()
      setAgentDashboardOpen(false)
    }
  }, [closeWorkspaceBoard, open, setAgentDashboardOpen])
  useEffect(() => {
    if (workspaceBoardOpen) {
      setZotzAgentQueueDrawerOpen(false)
    }
  }, [workspaceBoardOpen])
  useEffect(() => {
    if (agentDashboardOpen) {
      setZotzAgentQueueDrawerOpen(false)
    }
  }, [agentDashboardOpen])

  return (
    <ZotzAgentQueueDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  )
}
