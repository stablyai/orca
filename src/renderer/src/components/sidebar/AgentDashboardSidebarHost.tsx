import { useEffect, useRef } from 'react'
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
  const activeView = useAppStore((s) => s.activeView)
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
  // Why the drawer yields when the view changes: it is a non-modal sheet, so the sidebar stays
  // clickable underneath it, and a click there is a request for a different surface. Leaving the
  // drawer up paints it over the page the user just asked for. The workspace board already yields
  // to the drawer above; this is the same rule for the pages reached through activeView.
  //
  // Why the previous value rather than the current one: opening the drawer does not touch
  // activeView, so a plain "activeView is not terminal" test would also close a drawer opened
  // while standing on one of those pages, which is a surface the user did ask for.
  const previousViewRef = useRef(activeView)
  useEffect(() => {
    const changed = previousViewRef.current !== activeView
    previousViewRef.current = activeView
    if (changed) {
      setDrawerOpen(false)
    }
  }, [activeView, setDrawerOpen])

  return sidebarOpen ? (
    <AgentDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
