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
  const docked = useAppStore((s) => s.settings?.experimentalAgentDashboardDocked === true)
  const drawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  useEffect(() => {
    if (!docked && !sidebarOpen && drawerOpen) {
      setDrawerOpen(false)
    }
  }, [docked, drawerOpen, setDrawerOpen, sidebarOpen])
  useEffect(() => {
    if (!docked && drawerOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, docked, drawerOpen])
  useEffect(() => {
    if (!docked && workspaceBoardOpen) {
      setDrawerOpen(false)
    }
  }, [docked, setDrawerOpen, workspaceBoardOpen])

  return sidebarOpen && !docked ? (
    <AgentDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
