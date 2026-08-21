import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { AgentDashboardDrawer } from '@/components/dashboard/AgentDashboardDrawer'

type AgentDashboardSidebarHostProps = {
  sidebarOpen: boolean
  workspaceBoardOpen: boolean
  closeWorkspaceBoard: () => void
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}

/** Opt-in dashboard coordination stays outside the normal sidebar path. */
export default function AgentDashboardSidebarHost({
  sidebarOpen,
  workspaceBoardOpen,
  closeWorkspaceBoard,
  leftSidebarStyle,
  statusBarVisible
}: AgentDashboardSidebarHostProps): React.JSX.Element | null {
  const drawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  useEffect(() => {
    if (!sidebarOpen && drawerOpen) {
      setDrawerOpen(false)
    }
  }, [drawerOpen, setDrawerOpen, sidebarOpen])
  useEffect(() => {
    if (drawerOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, drawerOpen])
  useEffect(() => {
    if (workspaceBoardOpen) {
      setDrawerOpen(false)
    }
  }, [setDrawerOpen, workspaceBoardOpen])

  return sidebarOpen ? (
    <AgentDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
