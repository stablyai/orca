import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { AgentDashboardDrawer } from '@/components/dashboard/AgentDashboardDrawer'

type WorkspaceSurface = { worktreeId: string; groupId: string; tabId: string }

function readActiveWorkspaceSurface(s: AppState): WorkspaceSurface {
  const worktreeId = s.activeWorktreeId ?? ''
  const groupId = s.activeGroupIdByWorktree[worktreeId] ?? ''
  const tabId = s.groupsByWorktree[worktreeId]?.find((g) => g.id === groupId)?.activeTabId ?? ''
  return { worktreeId, groupId, tabId }
}

function selectActiveWorkspaceSurfaceKey(s: AppState): string {
  const { worktreeId, groupId, tabId } = readActiveWorkspaceSurface(s)
  return `${worktreeId}\u0000${groupId}\u0000${tabId}`
}

// Why: a surface change is navigation unless the previous tab is gone — a
// pty-exit close re-selects a neighbor, or deactivates an emptied worktree, with no user input.
function isUserNavigation(s: AppState, from: WorkspaceSurface): boolean {
  const groups = s.groupsByWorktree[from.worktreeId]
  // Why: deleting a worktree drops its groups entry; a pty exit leaves it in place.
  if (!from.tabId || !groups) {
    return true
  }
  return groups.some((g) => g.tabOrder.includes(from.tabId))
}

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
  const surfaceKey = useAppStore(selectActiveWorkspaceSurfaceKey)
  const lastSurfaceRef = useRef<{
    key: string
    surface: WorkspaceSurface | null
  }>({
    key: surfaceKey,
    surface: null
  })

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
  // Why: sidebar and tab-bar clicks are outside-dismiss exempt, so yield on the
  // navigation they cause. Keyed on the transition so opening over a page still works.
  useEffect(() => {
    const state = useAppStore.getState()
    const surface = readActiveWorkspaceSurface(state)
    const last = lastSurfaceRef.current
    lastSurfaceRef.current = { key: surfaceKey, surface }
    if (last.key === surfaceKey || !last.surface) {
      return
    }
    if (drawerOpen && isUserNavigation(state, last.surface)) {
      setDrawerOpen(false)
    }
  }, [drawerOpen, setDrawerOpen, surfaceKey])

  return sidebarOpen ? (
    <AgentDashboardDrawer leftSidebarStyle={leftSidebarStyle} statusBarVisible={statusBarVisible} />
  ) : null
}
