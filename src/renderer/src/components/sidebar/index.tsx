import React, { useEffect } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import NonGitFolderDialog from './NonGitFolderDialog'
import RemoveFolderDialog from './RemoveFolderDialog'
import AddRepoDialog from './AddRepoDialog'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

type SidebarProps = {
  worktreeScrollOffsetRef: React.MutableRefObject<number>
  worktreeScrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
}

function Sidebar({
  worktreeScrollOffsetRef,
  worktreeScrollAnchorRef
}: SidebarProps): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)

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

        <WorktreeList
          scrollOffsetRef={worktreeScrollOffsetRef}
          scrollAnchorRef={worktreeScrollAnchorRef}
        />

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
      <NonGitFolderDialog />
      <RemoveFolderDialog />
      <AddRepoDialog />
      <OrcaYamlTrustDialog />
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
