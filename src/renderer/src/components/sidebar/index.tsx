import React, { useEffect } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import SearchBar from './SearchBar'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import NonGitFolderDialog from './NonGitFolderDialog'
import RemoveFolderDialog from './RemoveFolderDialog'
import AddRepoDialog from './AddRepoDialog'
import AgentDashboard from '../dashboard/AgentDashboard'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

function Sidebar(): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const sidebarView = useAppStore((s) => s.sidebarView)
  const dashboardExperimentEnabled = useAppStore(
    (s) => s.settings?.experimentalAgentDashboard === true
  )
  // Why: the agent-management view is its own top-level peer to Workspaces —
  // clicking the Agents toggle in the header replaces the list below the
  // header rather than overlaying a second panel. Search and the worktree
  // list are Workspaces-only affordances; the agent dashboard owns its own
  // search + filter bar so a second search row would duplicate the control.
  //
  // Also gate on the experiment so that if the user disables the feature
  // from Settings while parked on the Agents view, the sidebar doesn't
  // render a now-orphaned dashboard — it falls back to Workspaces. We don't
  // write sidebarView back to 'workspaces' here because that would be a
  // side effect during render; the view variable is session-only and will
  // correctly re-enable the Agents panel the moment the setting flips back
  // on without needing to be "repaired" on disable.
  const showAgentsView = sidebarView === 'agents' && dashboardExperimentEnabled

  // Fetch worktrees when repos are added/removed
  const repoCount = repos.length
  useEffect(() => {
    if (repoCount > 0) {
      fetchAllWorktrees()
    }
  }, [repoCount, fetchAllWorktrees])

  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: sidebarOpen,
    width: sidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    deltaSign: 1,
    setWidth: setSidebarWidth
  })

  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-shrink-0 bg-sidebar flex flex-col overflow-hidden scrollbar-sleek-parent"
      >
        {/* Fixed controls */}
        <SidebarNav />
        <SidebarHeader />
        {/* Why: SearchBar renders in BOTH views so the chrome above the list
            doesn't shift when the user flips to Agents. The dashboard reads
            `searchQuery` from the same store field, so typing filters the
            visible panel either way. The filter button's repo picker also
            scopes the Agents view (see useDashboardFilter); its "Active only"
            toggle is intentionally inert in Agents view to avoid overlapping
            the dashboard's own state-filter axis. */}
        <SearchBar />

        {showAgentsView ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AgentDashboard />
          </div>
        ) : (
          <WorktreeList />
        )}

        {/* Fixed bottom toolbar */}
        <SidebarToolbar />

        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Dialog (rendered outside sidebar to avoid clipping) */}
      <WorktreeMetaDialog />
      <DeleteWorktreeDialog />
      <NonGitFolderDialog />
      <RemoveFolderDialog />
      <AddRepoDialog />
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
