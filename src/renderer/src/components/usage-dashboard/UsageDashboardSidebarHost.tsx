import { useEffect, type CSSProperties } from 'react'
import { useAppStore } from '@/store'
import { useDrawerCloseLingering } from '@/hooks/use-drawer-close-lingering'
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
  // The Sheet owns its close transition; unmounting on the same tick would cut it.
  const renderedOpen = useDrawerCloseLingering(drawerOpen)

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

  return sidebarOpen && renderedOpen ? (
    <UsageDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
