import React, { useMemo } from 'react'
import { Files, Search, GitBranch, ListChecks } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import type { RightSidebarTab, ActivityBarPosition } from '@/store/slices/editor'
import type { CheckStatus } from '../../../../shared/types'
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

const MIN_WIDTH = 220
const MAX_WIDTH = 500

const ACTIVITY_BAR_SIDE_WIDTH = 40

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function findWorktreeById(
  worktreesByRepo: ReturnType<typeof useAppStore.getState>['worktreesByRepo'],
  worktreeId: string | null
) {
  if (!worktreeId) {
    return null
  }

  for (const worktrees of Object.values(worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree
    }
  }

  return null
}

function getActiveChecksStatus(state: ReturnType<typeof useAppStore.getState>): CheckStatus | null {
  const activeWorktree = findWorktreeById(state.worktreesByRepo, state.activeWorktreeId)
  if (!activeWorktree) {
    return null
  }

  const activeRepo = state.repos.find((repo) => repo.id === activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  const prCacheKey = `${activeRepo.path}::${branch}`
  return state.prCache[prCacheKey]?.data?.checksStatus ?? null
}

type ActivityBarItem = {
  id: RightSidebarTab
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
  /** When true, hidden for non-git (folder-mode) repos. */
  gitOnly?: boolean
}

const isMac = navigator.userAgent.includes('Mac')
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
  }
]

function RightSidebarInner(): React.JSX.Element {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const checksStatus = useAppStore(getActiveChecksStatus)
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)

  // Why: source control and checks are meaningless for non-git folders.
  // Hide those tabs so the activity bar only shows relevant actions.
  const activeRepo = useAppStore((s) => {
    const wt = findWorktreeById(s.worktreesByRepo, s.activeWorktreeId)
    return wt ? (s.repos.find((r) => r.id === wt.repoId) ?? null) : null
  })
  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const visibleItems = useMemo(
    () => (isFolder ? ACTIVITY_ITEMS.filter((item) => !item.gitOnly) : ACTIVITY_ITEMS),
    [isFolder]
  )

  // If the active tab is hidden (e.g. switched from a git repo to a folder),
  // fall back to the first visible tab.
  const effectiveTab = visibleItems.some((item) => item.id === rightSidebarTab)
    ? rightSidebarTab
    : visibleItems[0].id

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: rightSidebarOpen,
    width: rightSidebarWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })

  const panelContent = (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Why: sidebar panels no longer use key={activeWorktreeId} because
          the full unmount/remount cycle on every worktree switch triggered
          an IPC storm (watchWorktree + readDir + git:branchCompare + …)
          that froze the app for seconds on Windows.  Each panel now reacts
          to activeWorktreeId changes via store subscriptions and reset
          effects, keeping the component instance alive across switches. */}
      {effectiveTab === 'explorer' && <FileExplorer />}
      {effectiveTab === 'search' && <SearchPanel />}
      {effectiveTab === 'source-control' && <SourceControl />}
      {effectiveTab === 'checks' && <ChecksPanel />}
    </div>
  )

  const activityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => setRightSidebarTab(item.id)}
      layout={activityBarPosition}
      statusIndicator={item.id === 'checks' ? checksStatus : null}
    />
  ))

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
            <ContextMenuTrigger asChild>
              <div className="flex items-center border-b border-border h-[33px] min-h-[33px] px-1">
                <TooltipProvider delayDuration={400}>{activityBarIcons}</TooltipProvider>
              </div>
            </ContextMenuTrigger>
            <ActivityBarPositionMenu
              currentPosition={activityBarPosition}
              onChangePosition={setActivityBarPosition}
            />
          </ContextMenu>
        ) : (
          /* ── Side layout: static title header ── */
          <div className="flex items-center h-[33px] min-h-[33px] px-3 border-b border-border">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
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
            <div className="flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border">
              <TooltipProvider delayDuration={400}>{activityBarIcons}</TooltipProvider>
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

// ─── Status indicator dot color mapping ──────
const STATUS_DOT_COLOR: Record<CheckStatus, string> = {
  success: 'bg-emerald-500',
  failure: 'bg-rose-500',
  pending: 'bg-amber-500',
  neutral: 'bg-muted-foreground'
}

// ─── Activity Bar Button (shared for top + side) ──────
function ActivityBarButton({
  item,
  active,
  onClick,
  layout,
  statusIndicator
}: {
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  layout: 'top' | 'side'
  statusIndicator?: CheckStatus | null
}): React.JSX.Element {
  const Icon = item.icon
  const isTop = layout === 'top'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'relative flex items-center justify-center transition-colors',
            isTop ? 'h-[33px] w-9' : 'w-10 h-10',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={onClick}
          aria-label={`${item.title} (${item.shortcut})`}
        >
          <Icon size={isTop ? 16 : 18} />

          {/* Status indicator dot */}
          {statusIndicator && statusIndicator !== 'neutral' && (
            <div
              className={cn(
                'absolute rounded-full size-[7px] ring-1 ring-sidebar',
                isTop ? 'top-[5px] right-[5px]' : 'top-[7px] right-[7px]',
                STATUS_DOT_COLOR[statusIndicator] ?? 'bg-muted-foreground'
              )}
            />
          )}

          {/* Active indicator */}
          {active && isTop && (
            <div className="absolute bottom-0 left-[25%] right-[25%] h-[2px] bg-foreground rounded-t" />
          )}
          {active && !isTop && (
            <div className="absolute right-0 top-[25%] bottom-[25%] w-[2px] bg-foreground rounded-l" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
        {item.title} ({item.shortcut})
      </TooltipContent>
    </Tooltip>
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
