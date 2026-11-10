import React, { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import SidebarHeader from './SidebarHeader'
import SidebarNav from './SidebarNav'
import { setSidebarLiveWidth } from './sidebar-live-width'
import SetupScriptPromptCard from './SetupScriptPromptCard'
import WorktreeList from './worktree-list/listing/WorktreeList'
import WslMovedProjectsSection from './WslMovedProjectsSection'
import SidebarToolbar from './SidebarToolbar'
import WorkspaceKanbanDrawer from './workspace-board/surface/WorkspaceKanbanDrawer'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { cn } from '@/lib/class-names'
import { FolderPlus, Loader2 } from 'lucide-react'
import { ActivityThreadCollapseContext } from '@/components/activity/activity-thread-collapse-context'
import { useSidebarProjectDrop } from './project-admission/drop/useSidebarProjectDrop'
import { useWorkspaceBoardPanel } from './workspace-board/surface/useWorkspaceBoardPanel'
import { useWorkspaceRevealBodyRedirect } from './worktree-list/navigation/use-workspace-reveal-body-redirect'
import { resolveLeftSidebarStyleVariables } from '@/app-shell/appearance/left-sidebar-appearance'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { usePerforceCopySync } from '../perforce-copies/use-perforce-copy-sync'
import { LocalGitToolchainScanBanner } from './LocalGitToolchainScanBanner'
import { SeveredTerminalDaemonBanner } from './SeveredTerminalDaemonBanner'
import { StalledTerminalDaemonBanner } from './StalledTerminalDaemonBanner'
import { StartupWorktreeRefreshStatus } from './StartupWorktreeRefreshStatus'

// Load the shared Activity badge/list pipeline after the sidebar shell.
const SidebarAgentsList = lazyWithRetry(() => import('./SidebarAgentsList'))

const WorktreeMetaDialog = lazyWithRetry(
  () => import('./workspace-card/metadata/WorktreeMetaDialog')
)
const RemoveFolderDialog = lazyWithRetry(() => import('./RemoveFolderDialog'))
const SleepTwinWorkspaceDialog = lazyWithRetry(
  () => import('./workspace-actions/sleep/SleepTwinWorkspaceDialog')
)
const WorktreeVisibilityDialog = lazyWithRetry(
  () => import('./workspace-visibility/dialog/WorktreeVisibilityDialog')
)
const OrcaYamlTrustDialog = lazyWithRetry(() => import('./OrcaYamlTrustDialog'))
const ForgetSshWorkspaceDialog = lazyWithRetry(
  () => import('./workspace-actions/deletion/ForgetSshWorkspaceDialog')
)
const PerforceCopyDeleteModal = lazyWithRetry(
  () => import('../perforce-copies/PerforceCopyDeleteModal')
)
const PerforceCopyUpModal = lazyWithRetry(() => import('../perforce-copies/PerforceCopyUpModal'))
const PerforceCopiesModal = lazyWithRetry(() => import('../perforce-copies/PerforceCopiesModal'))
const PerforceOpenForEditDialog = lazyWithRetry(
  () => import('../right-sidebar/perforce/PerforceOpenForEditDialog')
)
const AgentDashboardSidebarHost = lazyWithRetry(() => import('./AgentDashboardSidebarHost'))

const MIN_WIDTH = 220
const MAX_WIDTH = 500
// Why: start on the divider pixel so pointing at the visible seam resizes instead of scrolling the list.
export const WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME =
  'peer absolute -right-[9px] top-0 z-20 h-full w-[9px] cursor-col-resize'
// Why: an open drawer covers the outer side of the seam, so keep the inner overlap wide enough to grab.
const WORKTREE_SIDEBAR_RESIZE_HANDLE_UNDER_DRAWER_CLASS_NAME = '-right-1.5 w-3'
export const WORKTREE_SIDEBAR_RESIZE_HANDLE_LINE_CLASS_NAME =
  'pointer-events-none absolute -right-px top-0 z-20 h-full w-px bg-transparent transition-colors peer-hover:bg-ring/50 peer-active:bg-ring'

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
  const startupWorktreeRefreshCompleted = useAppStore((s) => s.startupWorktreeRefreshCompleted)
  const settings = useAppStore((s) => s.settings)
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const showAgentDashboard = settings?.experimentalAgentDashboardPopout === true
  const agentDashboardDrawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setAgentDashboardDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)
  const agentReadFilter = useAppStore((s) => s.agentsReadFilter)
  const setAgentReadFilter = useAppStore((s) => s.setAgentsReadFilter)
  const agentGroupBy = useAppStore((s) => s.agentsGroupBy)
  const setAgentGroupBy = useAppStore((s) => s.setAgentsGroupBy)
  const [agentQuery, setAgentQuery] = React.useState('')
  const [agentOptionsTarget, setAgentOptionsTarget] = React.useState<HTMLDivElement | null>(null)
  const [projectsCollapseTarget, setProjectsCollapseTarget] = React.useState<HTMLDivElement | null>(
    null
  )
  const [agentBadgeTarget, setAgentBadgeTarget] = React.useState<HTMLSpanElement | null>(null)
  const agentsScrollTopRef = React.useRef(0)
  // Retain collapse state and scroll geometry across Agents-list unmounts.
  const [agentsCollapsedGroupKeys, setAgentsCollapsedGroupKeys] = React.useState<
    ReadonlySet<string>
  >(() => new Set())
  const agentsCollapseState = useMemo(
    () => ({
      collapsedGroupKeys: agentsCollapsedGroupKeys,
      onToggleGroupCollapse: (groupKey: string) =>
        setAgentsCollapsedGroupKeys((prev) => {
          const next = new Set(prev)
          if (next.has(groupKey)) {
            next.delete(groupKey)
          } else {
            next.add(groupKey)
          }
          return next
        })
    }),
    [agentsCollapsedGroupKeys]
  )
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const activeModal = useAppStore((s) => s.activeModal)
  usePerforceCopySync()
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const leftSidebarStyle = useMemo(() => resolveLeftSidebarStyleVariables(settings), [settings])
  const { dropOwnerRef, dropHandlers, affordance } = useSidebarProjectDrop()
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

  const repoCount = repos.length
  const previousRepoCountRef = React.useRef(repoCount)
  useEffect(() => {
    const repoCountChanged = previousRepoCountRef.current !== repoCount
    previousRepoCountRef.current = repoCount
    // Why: App owns the initial all-host scan; partial startup catalogs must not trigger broad scans or stale-state purges.
    if (startupWorktreeRefreshCompleted && repoCountChanged && repoCount > 0) {
      void fetchAllWorktrees()
    }
  }, [repoCount, startupWorktreeRefreshCompleted, fetchAllWorktrees])

  useEffect(() => {
    if (!sidebarOpen && workspaceBoardRenderedOpen) {
      closeWorkspaceBoard()
    }
  }, [closeWorkspaceBoard, sidebarOpen, workspaceBoardRenderedOpen])

  useEffect(() => {
    if (!showAgentDashboard && agentDashboardDrawerOpen) {
      setAgentDashboardDrawerOpen(false)
    }
  }, [agentDashboardDrawerOpen, setAgentDashboardDrawerOpen, showAgentDashboard])

  const { containerRef, onResizeStart, isResizing } = useSidebarResize<HTMLDivElement>({
    isOpen: sidebarOpen,
    width: sidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    deltaSign: 1,
    setWidth: setSidebarWidth,
    onDraftWidthChange: setSidebarLiveWidth
  })

  const drawerCoversSeam =
    workspaceBoardRenderedOpen || (showAgentDashboard && agentDashboardDrawerOpen)

  useWorkspaceRevealBodyRedirect(sidebarOpen && sidebarBody === 'agents')
  // A collapsed sidebar takes no drops.
  const sidebarRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      dropOwnerRef(sidebarOpen ? node : null)
    },
    [containerRef, dropOwnerRef, sidebarOpen]
  )

  return (
    <TooltipProvider>
      {/* Why: the handle lives outside the clipped sidebar so its outer half isn't cut off. */}
      <div className="relative flex min-h-0 flex-shrink-0 scrollbar-sleek-parent">
        <div
          ref={sidebarRef}
          className="relative min-h-0 flex-shrink-0 bg-worktree-sidebar flex flex-col overflow-hidden"
          style={leftSidebarStyle}
          {...dropHandlers}
        >
          {sidebarOpen && (
            <>
              <SidebarNav />
              <SidebarHeader
                activityBadgeTarget={setAgentBadgeTarget}
                onWorkspaceBoardMenuOpenChange={setWorkspaceBoardMenuOpen}
                activityOptionsTarget={setAgentOptionsTarget}
                projectsCollapseTarget={setProjectsCollapseTarget}
              />
              <SeveredTerminalDaemonBanner />
              <StalledTerminalDaemonBanner />
              <React.Suspense
                fallback={sidebarBody === 'agents' ? <div className="min-h-0 flex-1" /> : null}
              >
                <ActivityThreadCollapseContext.Provider value={agentsCollapseState}>
                  <SidebarAgentsList
                    active={sidebarBody === 'agents'}
                    readFilter={agentReadFilter}
                    setReadFilter={setAgentReadFilter}
                    groupBy={agentGroupBy}
                    setGroupBy={setAgentGroupBy}
                    query={agentQuery}
                    setQuery={setAgentQuery}
                    optionsTarget={agentOptionsTarget}
                    badgeTarget={agentBadgeTarget}
                    scrollTopRef={agentsScrollTopRef}
                  />
                </ActivityThreadCollapseContext.Provider>
              </React.Suspense>
              {sidebarBody !== 'agents' && (
                <>
                  <LocalGitToolchainScanBanner />
                  <StartupWorktreeRefreshStatus />
                  <WorktreeList
                    scrollOffsetRef={worktreeScrollOffsetRef}
                    scrollAnchorRef={worktreeScrollAnchorRef}
                    workspaceBoardOpen={workspaceBoardOpen}
                    onWorktreeCardClick={closeWorkspaceBoard}
                    onWorkspaceBoardDragPreviewStart={previewWorkspaceBoardFromDrag}
                    onWorkspaceBoardDragPreviewCommit={solidifyWorkspaceBoardFromDrag}
                    onWorkspaceBoardDragPreviewCancel={cancelWorkspaceBoardDragPreview}
                    projectsCollapseTarget={projectsCollapseTarget}
                  />
                  <WslMovedProjectsSection />
                </>
              )}

              <div className="relative shrink-0">
                <SetupScriptPromptCard />

                <SidebarToolbar
                  workspaceBoardOpen={workspaceBoardOpen}
                  workspaceBoardDragPreviewOpen={workspaceBoardDragPreviewOpen}
                  onWorkspaceBoardToggle={toggleWorkspaceBoard}
                />
              </div>
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
        </div>

        {sidebarOpen && (
          <>
            <div
              data-sidebar-resize-handle=""
              className={cn(
                WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME,
                drawerCoversSeam && WORKTREE_SIDEBAR_RESIZE_HANDLE_UNDER_DRAWER_CLASS_NAME,
                isResizing && 'bg-ring/10'
              )}
              onMouseDown={onResizeStart}
            />
            <div
              className={cn(
                WORKTREE_SIDEBAR_RESIZE_HANDLE_LINE_CLASS_NAME,
                isResizing && 'bg-ring'
              )}
            />
          </>
        )}
      </div>

      {/* Render dialogs outside the sidebar to avoid clipping; mount each flow only while its modal is active. */}
      <React.Suspense fallback={null}>
        {activeModal === 'edit-meta' ? <WorktreeMetaDialog /> : null}
        {activeModal === 'confirm-remove-folder' ? <RemoveFolderDialog /> : null}
        {activeModal === 'confirm-sleep-twin' ? <SleepTwinWorkspaceDialog /> : null}
        {activeModal === 'worktree-visibility' ? <WorktreeVisibilityDialog /> : null}
        {activeModal === 'confirm-orca-yaml-hooks' ? <OrcaYamlTrustDialog /> : null}
        {activeModal === 'forget-ssh-workspace' ? <ForgetSshWorkspaceDialog /> : null}
        {activeModal === 'delete-perforce-copy' ? <PerforceCopyDeleteModal /> : null}
        {activeModal === 'copy-up-perforce-copy' ? <PerforceCopyUpModal /> : null}
        {activeModal === 'perforce-copies' ? <PerforceCopiesModal /> : null}
        {activeModal === 'perforce-open-for-edit' ? <PerforceOpenForEditDialog /> : null}
      </React.Suspense>
      {sidebarOpen ? (
        <WorkspaceKanbanDrawer
          leftSidebarStyle={leftSidebarStyle}
          open={workspaceBoardRenderedOpen}
          statusBarVisible={statusBarVisible}
          dragPreview={workspaceBoardDragPreviewOpen}
          preserveOpenForMenu={workspaceBoardMenuOpen}
          onOpenChange={handleWorkspaceBoardOpenChange}
          onMenuOpenChange={setWorkspaceBoardMenuOpen}
        />
      ) : null}
      {showAgentDashboard ? (
        <React.Suspense fallback={null}>
          <AgentDashboardSidebarHost
            sidebarOpen={sidebarOpen}
            workspaceBoardOpen={workspaceBoardOpen}
            closeWorkspaceBoard={closeWorkspaceBoard}
            leftSidebarStyle={leftSidebarStyle}
            statusBarVisible={statusBarVisible}
          />
        </React.Suspense>
      ) : null}
    </TooltipProvider>
  )
}

export default React.memo(Sidebar)
