import React, { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import ScriptRunner from './ScriptRunner'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'
import NonGitFolderDialog from './NonGitFolderDialog'
import RemoveFolderDialog from './RemoveFolderDialog'
import AddRepoDialog from './AddRepoDialog'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'

const MIN_WIDTH = 220
const MAX_WIDTH = 500
const SCRIPT_RUNNER_MIN_HEIGHT = 80
const SCRIPT_RUNNER_MAX_HEIGHT = 600
const SCRIPT_RUNNER_DEFAULT_HEIGHT = 240

function Sidebar(): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  // Why: the runner is opt-in, so an unhydrated store or a settings profile
  // saved before this key existed must read as off rather than mounting the
  // panel and loading package scripts before the user has chosen.
  const scriptRunnerEnabled = useAppStore((s) => s.settings?.sidebarScriptRunnerEnabled ?? false)

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

  const [scriptRunnerHeight, setScriptRunnerHeight] = useState(SCRIPT_RUNNER_DEFAULT_HEIGHT)

  const onScriptRunnerSplitterMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = scriptRunnerHeight

      const handleMove = (ev: MouseEvent): void => {
        // Why: dragging the splitter up grows the bottom panel, so subtract
        // the cursor delta from the starting height instead of adding it.
        const next = Math.min(
          SCRIPT_RUNNER_MAX_HEIGHT,
          Math.max(SCRIPT_RUNNER_MIN_HEIGHT, startHeight + (startY - ev.clientY))
        )
        setScriptRunnerHeight(next)
      }
      const handleUp = (): void => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [scriptRunnerHeight]
  )

  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-shrink-0 bg-sidebar flex flex-col overflow-hidden scrollbar-sleek-parent"
      >
        {/* Fixed controls */}
        <SidebarNav />
        <SidebarHeader />

        <WorktreeList />

        {/* Script runner panel — split below navigation, draggable splitter */}
        {scriptRunnerEnabled && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              className="h-1 shrink-0 cursor-row-resize bg-sidebar-border/30 transition-colors hover:bg-ring/30 active:bg-ring/40"
              onMouseDown={onScriptRunnerSplitterMouseDown}
            />
            <div
              className="flex shrink-0 flex-col"
              style={{ height: `${scriptRunnerHeight}px` }}
            >
              <ScriptRunner />
            </div>
          </>
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
      <OrcaYamlTrustDialog />
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
