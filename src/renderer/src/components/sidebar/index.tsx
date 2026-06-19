import React, { useEffect, useMemo } from 'react'
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
import { lazyWithRetry } from '@/lib/lazy-with-retry'

const WorktreeMetaDialog = lazyWithRetry(() => import('./WorktreeMetaDialog'))
const RemoveFolderDialog = lazyWithRetry(() => import('./RemoveFolderDialog'))
const WorktreeVisibilityDialog = lazyWithRetry(() => import('./WorktreeVisibilityDialog'))
const OrcaYamlTrustDialog = lazyWithRetry(() => import('./OrcaYamlTrustDialog'))

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
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const activeModal = useAppStore((s) => s.activeModal)
  const systemPrefersDark = useSystemPrefersDark()
  const leftSidebarStyle = useMemo(
    () => resolveLeftSidebarStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  ) as React.CSSProperties | undefined
  const { nativeDropTarget, dropHandlers, affordance } = useSidebarProjectDrop()
  const {
    workspaceBoardOpen,
    workspaceBoardRenderedOpen,
    workspaceBoardDragPreviewOpen,
    workspaceBoardMenuOpen,
    toggleWorkspaceBoard,
    handleWorkspaceBoardOpenChange,
    setWorkspaceBoardMenuOpen,
    closeWorkspaceBoard,
    previewWorkspaceBoardFromDrag,
    solidifyWorkspaceBoardFromDrag,
    cancelWorkspaceBoardDragPreview
  } = useWorkspaceBoardPanel()

  const setLiveSidebarWidth = React.useCallback((width: number) => {
    document.documentElement.style.setProperty('--workspace-sidebar-live-width', `${width}px`)
  }, [])

  // Fetch worktrees when repos are added/removed
  const repoCount = repos.length
  useEffect(() => {
    if (repoCount > 0) {
      fetchAllWorktrees()
    }
  }, [repoCount, fetchAllWorktrees])

  // Why: a runtime host coming online/offline must refresh the sidebar so its
  // worktrees appear/drop, the same way SSH state changes already refetch. Only
  // the manual connect button refetched before, so the list went stale until the
  // user forced a refetch (e.g. via Add Project). React to the set of online
  // runtime envs (a host has a status entry once it is connected).
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const fetchWorktreeLineage = useAppStore((s) => s.fetchWorktreeLineage)
  const onlineRuntimeEnvKey = React.useMemo(
    () =>
      // Why: tolerate an absent map — a partial/hydrating store can leave this
      // undefined, and a thrown selector would crash the whole sidebar render.
      [...(runtimeStatusByEnvironmentId?.entries() ?? [])]
        .filter(([, entry]) => Boolean(entry?.status))
        .map(([id]) => id)
        .sort()
        .join(','),
    [runtimeStatusByEnvironmentId]
  )
  const previousOnlineRuntimeEnvKeyRef = React.useRef<string | null>(null)
  useEffect(() => {
    // Skip the initial value — startup/repoCount effects already fetch. Only
    // refetch when the online-host set actually changes.
    if (previousOnlineRuntimeEnvKeyRef.current === null) {
      previousOnlineRuntimeEnvKeyRef.current = onlineRuntimeEnvKey
      return
    }
    if (previousOnlineRuntimeEnvKeyRef.current === onlineRuntimeEnvKey) {
      return
    }
    previousOnlineRuntimeEnvKeyRef.current = onlineRuntimeEnvKey
    void fetchAllWorktrees().then(() => fetchWorktreeLineage())
  }, [onlineRuntimeEnvKey, fetchAllWorktrees, fetchWorktreeLineage])

  useEffect(() => {
    if (!sidebarOpen && workspaceBoardRenderedOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, sidebarOpen, workspaceBoardRenderedOpen])

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
        style={leftSidebarStyle}
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
              workspaceBoardOpen={workspaceBoardOpen}
              onWorkspaceBoardDragPreviewStart={previewWorkspaceBoardFromDrag}
              onWorkspaceBoardDragPreviewCommit={solidifyWorkspaceBoardFromDrag}
              onWorkspaceBoardDragPreviewCancel={cancelWorkspaceBoardDragPreview}
            />

            <SetupScriptPromptCard />

            {/* Fixed bottom toolbar */}
            <SidebarToolbar
              workspaceBoardOpen={workspaceBoardOpen}
              workspaceBoardDragPreviewOpen={workspaceBoardDragPreviewOpen}
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
          leftSidebarStyle={leftSidebarStyle}
          open={workspaceBoardRenderedOpen}
          dragPreview={workspaceBoardDragPreviewOpen}
          preserveOpenForMenu={workspaceBoardMenuOpen}
          onOpenChange={handleWorkspaceBoardOpenChange}
          onMenuOpenChange={setWorkspaceBoardMenuOpen}
        />
      ) : null}
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
