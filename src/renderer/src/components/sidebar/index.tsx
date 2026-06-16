import React, { useEffect } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import SetupScriptPromptCard from './SetupScriptPromptCard'
import WorktreeList from './WorktreeList'
import SidebarToolbar from './SidebarToolbar'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { cn } from '@/lib/utils'
import { FolderPlus, Loader2 } from 'lucide-react'
import { useSidebarProjectDrop } from './useSidebarProjectDrop'
import { useWorkspaceBoardPanel } from './useWorkspaceBoardPanel'
import { resolveLeftSidebarStyleVariables } from '@/lib/left-sidebar-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

const WorktreeMetaDialog = React.lazy(() => import('./WorktreeMetaDialog'))
const RemoveFolderDialog = React.lazy(() => import('./RemoveFolderDialog'))
const WorktreeVisibilityDialog = React.lazy(() => import('./WorktreeVisibilityDialog'))
const OrcaYamlTrustDialog = React.lazy(() => import('./OrcaYamlTrustDialog'))

const MIN_WIDTH = 220
const MAX_WIDTH = 500
// Why: match the right sidebar's 4px resize target; a 1px seam is too hard to acquire.
export const WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME =
  'absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 active:bg-ring/30'

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
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const activeModal = useAppStore((s) => s.activeModal)
  const { nativeDropTarget, dropHandlers, affordance } = useSidebarProjectDrop()
  const {
    workspaceBoardOpen,
    workspaceBoardMenuOpen,
    toggleWorkspaceBoard,
    handleWorkspaceBoardOpenChange,
    setWorkspaceBoardMenuOpen,
    closeWorkspaceBoard
  } = useWorkspaceBoardPanel()

  const setLiveSidebarWidth = React.useCallback((width: number) => {
    document.documentElement.style.setProperty('--workspace-sidebar-live-width', `${width}px`)
  }, [])

  // Why: scope the chosen left-sidebar appearance to this surface so the
  // workspace sidebar follows the setting, not just the settings preview.
  const systemPrefersDark = useSystemPrefersDark()
  const appearanceStyle = React.useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined

  // Fetch worktrees when repos are added/removed
  const repoCount = repos.length
  useEffect(() => {
    if (repoCount > 0) {
      fetchAllWorktrees()
    }
  }, [repoCount, fetchAllWorktrees])

  useEffect(() => {
    if (!sidebarOpen && workspaceBoardOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, sidebarOpen, workspaceBoardOpen])

  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: sidebarOpen,
    width: sidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    deltaSign: 1,
    setWidth: setSidebarWidth,
    onDraftWidthChange: setLiveSidebarWidth
  })

  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={containerRef}
        data-native-file-drop-target={sidebarOpen ? nativeDropTarget : undefined}
        className="relative min-h-0 flex-shrink-0 bg-worktree-sidebar flex flex-col overflow-hidden scrollbar-sleek-parent"
        style={appearanceStyle}
        {...dropHandlers}
      >
        {sidebarOpen && (
          <>
            {/* Fixed controls */}
            <SidebarNav />
            <SidebarHeader onWorkspaceBoardMenuOpenChange={setWorkspaceBoardMenuOpen} />

            <WorktreeList
              scrollOffsetRef={worktreeScrollOffsetRef}
              scrollAnchorRef={worktreeScrollAnchorRef}
            />

            <SetupScriptPromptCard />

            {/* Fixed bottom toolbar */}
            <SidebarToolbar
              workspaceBoardOpen={workspaceBoardOpen}
              onWorkspaceBoardToggle={toggleWorkspaceBoard}
            />
          </>
        )}

        {sidebarOpen && affordance.visible ? (
          <div
            className={cn(
              'pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-1.5 rounded-md border bg-worktree-sidebar-accent/95 px-4 text-center text-worktree-sidebar-accent-foreground shadow-xs',
              affordance.tone === 'blocked'
                ? 'border-destructive/70'
                : 'border-worktree-sidebar-ring/70'
            )}
          >
            {affordance.tone === 'busy' ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <FolderPlus className="size-5 text-muted-foreground" />
            )}
            <div className="text-sm font-medium">{affordance.label}</div>
            <div className="text-xs text-muted-foreground">{affordance.description}</div>
          </div>
        ) : null}

        {/* Resize handle */}
        {sidebarOpen && (
          <div
            data-sidebar-resize-handle=""
            className={WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME}
            onMouseDown={onResizeStart}
          />
        )}
      </div>

      {/* Dialogs render outside sidebar to avoid clipping. Lazy-load them only
      for the modal that needs their flow-specific hooks and UI. */}
      <React.Suspense fallback={null}>
        {activeModal === 'edit-meta' ? <WorktreeMetaDialog /> : null}
        {activeModal === 'confirm-remove-folder' ? <RemoveFolderDialog /> : null}
        {activeModal === 'worktree-visibility' ? <WorktreeVisibilityDialog /> : null}
        {activeModal === 'confirm-orca-yaml-hooks' ? <OrcaYamlTrustDialog /> : null}
      </React.Suspense>
      {sidebarOpen ? (
        <WorkspaceKanbanDrawer
          open={workspaceBoardOpen}
          preserveOpenForMenu={workspaceBoardMenuOpen}
          onOpenChange={handleWorkspaceBoardOpenChange}
          onMenuOpenChange={setWorkspaceBoardMenuOpen}
        />
      ) : null}
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
