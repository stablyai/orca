import { useEffect, type CSSProperties } from 'react'
import { useAppStore } from '@/store'
import UsageDashboardDrawer from './UsageDashboardDrawer'

type UsageDashboardSidebarHostProps = {
  sidebarOpen: boolean
  workspaceBoardOpen: boolean
  closeWorkspaceBoard: () => void
  leftSidebarStyle?: CSSProperties
  statusBarVisible: boolean
}

export default function UsageDashboardSidebarHost({
  sidebarOpen,
  workspaceBoardOpen,
  closeWorkspaceBoard,
  leftSidebarStyle,
  statusBarVisible
}: UsageDashboardSidebarHostProps): React.JSX.Element | null {
  const drawerOpen = useAppStore((s) => s.usageDrawerOpen)
  const setDrawerOpen = useAppStore((s) => s.setUsageDrawerOpen)

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

  return sidebarOpen && drawerOpen ? (
    <UsageDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
