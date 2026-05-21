import React, { useEffect, useMemo, useState } from 'react'
import { Plug, Files, Search, GitBranch, ListChecks, PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import type { ActivityBarPosition } from '@/store/slices/editor'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@/components/ui/context-menu'
import FileExplorer from './FileExplorer'
import SourceControl from './SourceControl'
import SearchPanel from './Search'
import ChecksPanel from './ChecksPanel'
import PortsPanel from './PortsPanel'
import { getTopActivityBarLayout } from './activity-bar-overflow'
import {
  ActivityBarButton,
  TopActivityOverflowMenu,
  type ActivityBarItem
} from './activity-bar-buttons'
import { getActiveChecksStatus } from './active-checks-status'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'

const MIN_WIDTH = 220
// Why: long file names (e.g. construction drawing sheets, multi-part document
// names) used to be truncated at a hard 500px cap that no drag could exceed.
// We now let the user drag up to nearly the full window width and only keep a
// small reserve so the rest of the app (left sidebar, editor) is not squeezed
// to zero — the practical ceiling still scales with the user's window size.
const MIN_NON_SIDEBAR_AREA = 320
const ABSOLUTE_FALLBACK_MAX_WIDTH = 2000

const ACTIVITY_BAR_SIDE_WIDTH = 40

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const isWindows =
  !isMac && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
const mod = isMac ? '\u2318' : 'Ctrl+'

const ACTIVITY_ITEMS: ActivityBarItem[] = [
  {
    id: 'explorer',
    icon: Files,
    title: 'Explorer',
    shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}E`
  },
  {
    id: 'search',
    icon: Search,
    title: 'Search',
    shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}F`
  },
  {
    id: 'source-control',
    icon: GitBranch,
    title: 'Source Control',
    shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}G`,
    gitOnly: true
  },
  {
    id: 'checks',
    icon: ListChecks,
    title: 'Checks',
    shortcut: `${isMac ? '\u21E7' : 'Shift+'}${mod}K`,
    gitOnly: true
  },
  {
    id: 'ports',
    icon: Plug,
    title: 'Ports',
    shortcut: '',
    sshOnly: true
  }
]

function RightSidebarInner(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore(getActiveChecksStatus)
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  // Why: source control and checks are meaningless for non-git folders.
  // Hide those tabs so the activity bar only shows relevant actions.
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const isSshRepo = Boolean(activeRepo?.connectionId)

  const visibleItems = useMemo(
    () => getVisibleRightSidebarActivityItems(ACTIVITY_ITEMS, { isFolder, isSshRepo }),
    [isFolder, isSshRepo]
  )

  // If the active tab is hidden (e.g. switched from a git repo to a folder),
  // fall back to the first visible tab.
  const effectiveTab = visibleItems.some((item) => item.id === rightSidebarTab)
    ? rightSidebarTab
    : visibleItems[0].id

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const maxWidth = useWindowAwareMaxWidth()
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: rightSidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth,
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = (
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'search' && <SearchPanel />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* Why: SSH port forwarding still depends on the raw ports.detect data,
            which the workspace-scoped status bar popover intentionally does not
            expose. Keep this panel reachable only for SSH worktrees. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
      </div>
    </div>
  )

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  const sideActivityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => setRightSidebarTab(item.id)}
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
          aria-label="Toggle right sidebar"
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {`Toggle right sidebar (${isMac ? '⌘L' : 'Ctrl+L'})`}
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
              {!isWindows && (
                <TooltipProvider delayDuration={400}>
                  <ContextMenuTrigger asChild>
                    <div
                      ref={topActivityStripRef}
                      className="right-sidebar-activity-strip flex min-w-0 flex-1 items-center overflow-hidden pl-2 right-sidebar-header-no-drag"
                    >
                      {/* Why: the top strip shares a narrow titlebar with the close
                          button and Windows controls. Overflow goes behind More
                          instead of creating a horizontally scrollable toolbar. */}
                      <div className="flex min-w-0 shrink">
                        {topActivityLayout.visibleItems.map((item) => (
                          <ActivityBarButton
                            key={item.id}
                            item={item}
                            active={effectiveTab === item.id}
                            onClick={() => setRightSidebarTab(item.id)}
                            layout="top"
                            statusIndicator={item.id === 'checks' ? checksStatus : null}
                          />
                        ))}
                      </div>
                      {topActivityLayout.overflowItems.length > 0 && (
                        <TopActivityOverflowMenu
                          items={topActivityLayout.overflowItems}
                          activeTab={effectiveTab}
                          onSelect={setRightSidebarTab}
                          checksStatus={checksStatus}
                        />
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <div className="flex shrink-0 items-center pr-1 right-sidebar-header-no-drag">
                    {closeButton}
                  </div>
                </TooltipProvider>
              )}
              {isWindows && (
                <TooltipProvider delayDuration={400}>
                  <div className="ml-auto flex shrink-0 items-center pr-1 right-sidebar-header-no-drag">
                    {closeButton}
                  </div>
                </TooltipProvider>
              )}
            </div>
            {isWindows && (
              <TooltipProvider delayDuration={400}>
                <ContextMenuTrigger asChild>
                  <div
                    ref={topActivityStripRef}
                    className="right-sidebar-activity-strip flex h-10 min-h-10 items-center border-b border-border px-2 right-sidebar-header-no-drag"
                  >
                    {/* Why: Windows has fixed native-style controls in the titlebar
                        area; keep sidebar navigation in the sidebar body so the
                        titlebar stays visually native instead of crowded. */}
                    <div className="flex min-w-0 flex-1 shrink">
                      {topActivityLayout.visibleItems.map((item) => (
                        <ActivityBarButton
                          key={item.id}
                          item={item}
                          active={effectiveTab === item.id}
                          onClick={() => setRightSidebarTab(item.id)}
                          layout="top"
                          statusIndicator={item.id === 'checks' ? checksStatus : null}
                        />
                      ))}
                    </div>
                    {topActivityLayout.overflowItems.length > 0 && (
                      <TopActivityOverflowMenu
                        items={topActivityLayout.overflowItems}
                        activeTab={effectiveTab}
                        onSelect={setRightSidebarTab}
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
             138px window-controls overlay, but the remaining 98px still overlaps
             the panel header. right-sidebar-header-side-inset applies exactly
             that remainder (138-40=98px) as padding-right so the close button
             clears the minimize button without the full 138px gap. */
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

// Why: the drag-resize max is a function of window width, not a constant, so
// users with wide displays can expand the sidebar far enough to read long file
// names. Falls back to a large constant in non-DOM environments (tests).
function useWindowAwareMaxWidth(): number {
  const [max, setMax] = useState(() => computeMaxRightSidebarWidth())

  useEffect(() => {
    function update(): void {
      setMax(computeMaxRightSidebarWidth())
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return max
}

function computeMaxRightSidebarWidth(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) {
    return ABSOLUTE_FALLBACK_MAX_WIDTH
  }
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_NON_SIDEBAR_AREA)
}

function useMeasuredWidth(onWidth: (width: number | null) => void) {
  const observerRef = React.useRef<ResizeObserver | null>(null)

  return React.useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null

      if (!node || typeof ResizeObserver === 'undefined') {
        onWidth(node ? node.getBoundingClientRect().width : null)
        return
      }

      const updateWidth = (): void => {
        onWidth(node.getBoundingClientRect().width)
      }
      updateWidth()
      const observer = new ResizeObserver(updateWidth)
      observer.observe(node)
      observerRef.current = observer
    },
    [onWidth]
  )
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
      <ContextMenuLabel>Activity Bar Position</ContextMenuLabel>
      <ContextMenuRadioGroup
        value={currentPosition}
        onValueChange={(v) => onChangePosition(v as ActivityBarPosition)}
      >
        <ContextMenuRadioItem value="top">Top</ContextMenuRadioItem>
        <ContextMenuRadioItem value="side">Side</ContextMenuRadioItem>
      </ContextMenuRadioGroup>
    </ContextMenuContent>
  )
}
