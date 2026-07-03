/* eslint-disable max-lines -- Why: the right sidebar owns activity-bar visibility, routing, and resize behavior as one interaction surface; splitting the tab table away would make hidden-tab fallbacks harder to audit. */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plug, Files, GitBranch, ListChecks, PanelRight, Workflow } from 'lucide-react'
import { useAppStore } from '@/store'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import type { ActivityBarPosition } from '@/store/slices/editor'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@/components/ui/context-menu'
import { getTopActivityBarLayout } from './activity-bar-overflow'
import {
  ActivityBarButton,
  TopActivityOverflowMenu,
  type ActivityBarItem
} from './activity-bar-buttons'
import { getActiveChecksStatus } from './active-checks-status'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
  RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME,
  RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME
} from './right-sidebar-titlebar-drag-regions'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'
import { translate } from '@/i18n/i18n'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './right-sidebar-measured-width'
import { normalizeRightSidebarRoute } from '@/store/right-sidebar-route'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import { resolveRightSidebarEffectiveTab } from './right-sidebar-effective-tab'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

const ACTIVITY_BAR_SIDE_WIDTH = 40

function RightSidebarInner(): React.JSX.Element {
  const hasDesktopWindowChrome = shouldRenderDesktopWindowChrome({
    platform: getRendererAppPlatform(),
    isWebClient: isPairedWebClientWindow()
  })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const explorerShortcut = useShortcutLabel('sidebar.explorer.toggle')
  const sourceControlShortcut = useShortcutLabel('sidebar.sourceControl.toggle')
  const checksShortcut = useShortcutLabel('sidebar.checks.toggle')
  const portsShortcut = useShortcutLabel('sidebar.ports.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarRouteRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const showRightSidebarFiles = useAppStore((s) => s.showRightSidebarFiles)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore((s) => (s.rightSidebarOpen ? getActiveChecksStatus(s) : null))
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const activeWorktreeId = useAppStore((s) => (rightSidebarOpen ? s.activeWorktreeId : null))
  // Why: source control and checks are meaningless for non-git folders.
  // Hide those tabs so the activity bar only shows relevant actions.
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeWorkspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const isFolderWorkspace = activeWorkspaceScope?.type === 'folder'
  const isFolder = isFolderWorkspace || (activeRepo ? isFolderRepo(activeRepo) : false)
  const isSshRepo = Boolean(activeRepo?.connectionId)

  const activityItems = useMemo<ActivityBarItem[]>(
    () => [
      {
        id: 'explorer',
        icon: Files,
        title: translate('auto.components.right.sidebar.index.8bc2bbc3a0', 'Explorer'),
        shortcut: explorerShortcut === 'Unassigned' ? '' : explorerShortcut
      },
      {
        id: 'vault',
        icon: AgentSessionHistoryIcon,
        title: translate('auto.components.right.sidebar.index.aiVaultSessionHistory', 'Agents'),
        shortcut: ''
      },
      {
        id: 'workspaces',
        icon: Workflow,
        title: translate(
          'auto.components.right.sidebar.index.folderWorkspaces',
          'Attached worktrees'
        ),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'pr-checks',
        icon: ListChecks,
        title: translate('auto.components.right.sidebar.index.parentPrChecks', 'PR Checks'),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'source-control',
        icon: GitBranch,
        title: translate('auto.components.right.sidebar.index.0314901467', 'Source Control'),
        shortcut: sourceControlShortcut === 'Unassigned' ? '' : sourceControlShortcut,
        gitOnly: true
      },
      {
        id: 'checks',
        icon: ListChecks,
        title: translate('auto.components.right.sidebar.index.83a10e3c44', 'Checks'),
        shortcut: checksShortcut === 'Unassigned' ? '' : checksShortcut,
        gitOnly: true
      },
      {
        id: 'ports',
        icon: Plug,
        title: translate('auto.components.right.sidebar.index.441733b630', 'Ports'),
        shortcut: portsShortcut === 'Unassigned' ? '' : portsShortcut,
        sshOnly: true
      }
    ],
    [checksShortcut, explorerShortcut, portsShortcut, sourceControlShortcut]
  )

  const visibleItems = useMemo(
    () =>
      getVisibleRightSidebarActivityItems(activityItems, {
        isFolder,
        isFolderWorkspace,
        isSshRepo
      }),
    [activityItems, isFolder, isFolderWorkspace, isSshRepo]
  )

  const rememberedFolderTabByWorkspaceKeyRef = useRef<Record<string, ActiveRightSidebarTab>>({})
  const lastRightSidebarRouteRequestIdRef = useRef(rightSidebarRouteRequestId)
  const activeFolderWorkspaceKey = isFolderWorkspace ? (activeWorktreeId ?? null) : null

  // If the active tab is hidden (e.g. switched from a folder workspace to a git
  // worktree), render a visible fallback without overwriting the stored route.
  // Folder workspaces keep a session-local effective-tab memory so a PR Checks
  // row can open a child Checks tab without erasing the parent's overview tab.
  const normalizedActiveTab = normalizeRightSidebarRoute(rightSidebarTab).rightSidebarTab
  const rememberedFolderTab = activeFolderWorkspaceKey
    ? rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey]
    : null
  const requestedFolderTab =
    activeFolderWorkspaceKey &&
    rightSidebarRouteRequestId !== lastRightSidebarRouteRequestIdRef.current
      ? normalizedActiveTab
      : null
  const effectiveTab = resolveRightSidebarEffectiveTab({
    normalizedActiveTab,
    visibleItems,
    activeFolderWorkspaceKey,
    rememberedFolderTab: requestedFolderTab ?? rememberedFolderTab
  })

  useEffect(() => {
    lastRightSidebarRouteRequestIdRef.current = rightSidebarRouteRequestId
  }, [rightSidebarRouteRequestId])

  useEffect(() => {
    if (!activeFolderWorkspaceKey || !visibleItems.some((item) => item.id === effectiveTab)) {
      return
    }
    rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey] = effectiveTab
  }, [activeFolderWorkspaceKey, effectiveTab, visibleItems])
  const selectActivityTab = (tab: ActiveRightSidebarTab): void => {
    if (activeFolderWorkspaceKey) {
      rememberedFolderTabByWorkspaceKeyRef.current[activeFolderWorkspaceKey] = tab
    }
    if (tab === 'explorer') {
      showRightSidebarFiles()
      return
    }
    setRightSidebarTab(tab)
  }

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const windowWidth = useWindowWidth()
  const maxWidth = computeMaxRightSidebarPanelWidth(windowWidth, activityBarSideWidth)
  const renderedRightSidebarWidth = clampRightSidebarPanelWidth(
    rightSidebarWidth,
    windowWidth,
    activityBarSideWidth
  )
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: renderedRightSidebarWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth,
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Why: sidebar panels no longer use key={activeWorktreeId} because
          the full unmount/remount cycle on every worktree switch triggered
          an IPC storm (watchWorktree + readDir + git:branchCompare + …)
          that froze the app for seconds on Windows.  Each panel now reacts
          to activeWorktreeId changes via store subscriptions and reset
          effects, keeping the component instance alive across switches. */}
      {/* Why: live agent activity now renders inline inside each workspace
          card (WorktreeCardAgents, toggled by the 'inline-agents' card
          property) rather than in a bottom-docked dashboard panel that
          competed with file Explorer/Search for vertical space. The right
          sidebar is back to tab-only content. */}
      <RightSidebarPanelContent effectiveTab={effectiveTab} rightSidebarOpen={rightSidebarOpen} />
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  const sideActivityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => selectActivityTab(item.id)}
      layout="side"
      statusIndicator={item.id === 'checks' ? checksStatus : null}
    />
  ))

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label={translate(
            'auto.components.right.sidebar.index.e8e2e4ce74',
            'Toggle right sidebar'
          )}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate(
          'auto.components.right.sidebar.index.9fffaf17c1',
          'Toggle right sidebar ({{value0}})',
          { value0: rightSidebarShortcut }
        )}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        // Why: overflow-visible is needed when open so the resize handle
        // on the left edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      {/* Panel content area */}
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {activityBarPosition === 'top' ? (
          /* ── Top activity bar: horizontal icon row ── */
          <ContextMenu>
            <div className="flex h-[36px] min-h-[36px] items-center border-b border-border right-sidebar-header-inset right-sidebar-header-drag overflow-hidden">
              {!hasDesktopWindowChrome && (
                <TooltipProvider delayDuration={400}>
                  <ContextMenuTrigger asChild>
                    <div
                      ref={topActivityStripRef}
                      className={RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME}
                    >
                      <div
                        className={cn(
                          'flex min-w-0 shrink',
                          RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
                        )}
                      >
                        {/* Why: the top strip shares a narrow titlebar with the close
                            button and desktop window controls. Overflow goes
                            behind More instead of creating a horizontally
                            scrollable toolbar. */}
                        <div className="flex min-w-0 shrink">
                          {topActivityLayout.visibleItems.map((item) => (
                            <ActivityBarButton
                              key={item.id}
                              item={item}
                              active={effectiveTab === item.id}
                              onClick={() => selectActivityTab(item.id)}
                              layout="top"
                              statusIndicator={item.id === 'checks' ? checksStatus : null}
                            />
                          ))}
                        </div>
                        {topActivityLayout.overflowItems.length > 0 && (
                          <TopActivityOverflowMenu
                            items={topActivityLayout.overflowItems}
                            activeTab={effectiveTab}
                            onSelect={selectActivityTab}
                            checksStatus={checksStatus}
                          />
                        )}
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <div
                    className={cn(
                      'flex shrink-0 items-center pr-1',
                      RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
                    )}
                  >
                    {closeButton}
                  </div>
                </TooltipProvider>
              )}
              {hasDesktopWindowChrome && (
                <TooltipProvider delayDuration={400}>
                  <div
                    className={cn(
                      'ml-auto flex shrink-0 items-center pr-1',
                      RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
                    )}
                  >
                    {closeButton}
                  </div>
                </TooltipProvider>
              )}
            </div>
            {hasDesktopWindowChrome && (
              <TooltipProvider delayDuration={400}>
                <ContextMenuTrigger asChild>
                  <div
                    ref={topActivityStripRef}
                    className={RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME}
                  >
                    {/* Why: custom desktop chrome has fixed native-style controls
                        in the titlebar area; keep sidebar navigation in the
                        sidebar body so the titlebar stays visually native
                        instead of crowded. */}
                    <div className="flex min-w-0 flex-1 shrink">
                      {topActivityLayout.visibleItems.map((item) => (
                        <ActivityBarButton
                          key={item.id}
                          item={item}
                          active={effectiveTab === item.id}
                          onClick={() => selectActivityTab(item.id)}
                          layout="top"
                          statusIndicator={item.id === 'checks' ? checksStatus : null}
                        />
                      ))}
                    </div>
                    {topActivityLayout.overflowItems.length > 0 && (
                      <TopActivityOverflowMenu
                        items={topActivityLayout.overflowItems}
                        activeTab={effectiveTab}
                        onSelect={selectActivityTab}
                        checksStatus={checksStatus}
                      />
                    )}
                  </div>
                </ContextMenuTrigger>
              </TooltipProvider>
            )}
            <ActivityBarPositionMenu
              currentPosition={activityBarPosition}
              onChangePosition={setActivityBarPosition}
            />
          </ContextMenu>
        ) : (
          /* ── Side layout: static title header ── */
          /* Why: the 40px side activity bar absorbs the rightmost 40px of the
             138px window-controls overlay when custom desktop chrome is active,
             but the remaining 98px still overlaps the panel header.
             right-sidebar-header-side-inset applies exactly that remainder
             (138-40=98px) as padding-right so the close button clears the
             minimize button without the full 138px gap. */
          <div className="flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-side-inset right-sidebar-header-drag">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider delayDuration={400}>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        {/* Resize handle on LEFT side */}
        <div
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Side Activity Bar (icon strip on right edge) — only for 'side' position */}
      {activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border side-activity-bar-windows-inset">
              <TooltipProvider delayDuration={400}>{sideActivityBarIcons}</TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
          />
        </ContextMenu>
      )}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar

// Why: persisted right-sidebar widths can outlive the window size they were
// chosen in. Clamp from the current window so the terminal/editor never render
// underneath the sidebar after resize or hydration.
function useWindowWidth(): number | null {
  const [windowWidth, setWindowWidth] = useState(() => getWindowWidth())

  useEffect(() => {
    function update(): void {
      setWindowWidth(getWindowWidth())
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return windowWidth
}

function getWindowWidth(): number | null {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) {
    return null
  }
  return window.innerWidth
}

// ─── Context Menu for Activity Bar Position ───────────
function ActivityBarPositionMenu({
  currentPosition,
  onChangePosition
}: {
  currentPosition: ActivityBarPosition
  onChangePosition: (pos: ActivityBarPosition) => void
}): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuLabel>
        {translate('auto.components.right.sidebar.index.864111caa2', 'Activity Bar Position')}
      </ContextMenuLabel>
      <ContextMenuRadioGroup
        value={currentPosition}
        onValueChange={(v) => onChangePosition(v as ActivityBarPosition)}
      >
        <ContextMenuRadioItem value="top">
          {translate('auto.components.right.sidebar.index.7b415c39e9', 'Top')}
        </ContextMenuRadioItem>
        <ContextMenuRadioItem value="side">
          {translate('auto.components.right.sidebar.index.70893f017b', 'Side')}
        </ContextMenuRadioItem>
      </ContextMenuRadioGroup>
    </ContextMenuContent>
  )
}
