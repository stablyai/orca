import React, { useEffect } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SearchBar from './SearchBar'
import GroupControls from './GroupControls'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import AddWorktreeDialog from './AddWorktreeDialog'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import NonGitFolderDialog from './NonGitFolderDialog'
import RemoveFolderDialog from './RemoveFolderDialog'
import AddRepoDialog from './AddRepoDialog'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

export default function Sidebar(): React.JSX.Element {
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

  const { containerRef, onResizeStart, renderedOpen, contentAnimationState } =
    useSidebarResize<HTMLDivElement>({
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
        className="relative flex-shrink-0 bg-sidebar flex flex-col overflow-hidden scrollbar-sleek-parent"
        style={{
          borderRight: renderedOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col transition-[transform,opacity] duration-200 ease-out',
            contentAnimationState === 'open' || contentAnimationState === 'opening'
              ? 'translate-x-0 opacity-100'
              : '-translate-x-3 opacity-0'
          )}
        >
          {/* Fixed controls */}
          <SidebarHeader />
          <SearchBar />
          <GroupControls />

          {/* Virtualized scrollable list */}
          <WorktreeList />

          {/* Fixed bottom toolbar */}
          <SidebarToolbar />
        </div>

        {/* Resize handle */}
        {renderedOpen ? (
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
            onMouseDown={onResizeStart}
          />
        ) : null}
      </div>

      {/* Dialog (rendered outside sidebar to avoid clipping) */}
      <AddWorktreeDialog />
      <WorktreeMetaDialog />
      <DeleteWorktreeDialog />
      <NonGitFolderDialog />
      <RemoveFolderDialog />
      <AddRepoDialog />
    </TooltipProvider>
  )
}
