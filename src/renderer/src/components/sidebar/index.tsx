import React, { useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import SidebarHeader from './SidebarHeader'
import SearchBar from './SearchBar'
import GroupControls from './GroupControls'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import AddWorktreeDialog from './AddWorktreeDialog'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'

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

  // ─── Resize logic ───────────────────────────────────────────────────
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing.current) {
        return
      }
      const delta = e.clientX - startX.current
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      setSidebarWidth(next)
    },
    [setSidebarWidth]
  )

  const handleMouseUp = useCallback(() => {
    isResizing.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isResizing.current = true
      startX.current = e.clientX
      startWidth.current = sidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth]
  )

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="relative flex-shrink-0 bg-sidebar flex flex-col overflow-hidden transition-[width] duration-200 scrollbar-sleek-parent"
        style={{
          width: sidebarOpen ? sidebarWidth : 0,
          borderRight: sidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {/* Fixed controls */}
        <SidebarHeader />
        <SearchBar />
        <GroupControls />

        {/* Virtualized scrollable list */}
        <WorktreeList />

        {/* Fixed bottom toolbar */}
        <SidebarToolbar />

        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Dialog (rendered outside sidebar to avoid clipping) */}
      <AddWorktreeDialog />
      <WorktreeMetaDialog />
      <DeleteWorktreeDialog />
    </TooltipProvider>
  )
}
