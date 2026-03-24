import React, { useCallback, useRef, useEffect } from 'react'
import { Files, Search, GitBranch } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { RightSidebarTab, ActivityBarPosition } from '@/store/slices/editor'
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

const MIN_WIDTH = 220
const MAX_WIDTH = 500

const ACTIVITY_BAR_SIDE_WIDTH = 40

type ActivityBarItem = {
  id: RightSidebarTab
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
}

const ACTIVITY_ITEMS: ActivityBarItem[] = [
  { id: 'explorer', icon: Files, title: 'Explorer', shortcut: '\u21E7\u2318E' },
  { id: 'source-control', icon: GitBranch, title: 'Source Control', shortcut: '\u21E7\u2318G' },
  { id: 'search', icon: Search, title: 'Search', shortcut: '\u21E7\u2318F' }
]

export default function RightSidebar(): React.JSX.Element {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)

  // ─── Resize logic (handle on LEFT edge) ────────────
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing.current) {
        return
      }
      const delta = startX.current - e.clientX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      setRightSidebarWidth(next)
    },
    [setRightSidebarWidth]
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
      startWidth.current = rightSidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [rightSidebarWidth]
  )

  const totalWidth = rightSidebarOpen
    ? rightSidebarWidth + (activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0)
    : 0

  const panelContent = (
    <div className="flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {rightSidebarTab === 'explorer' && <FileExplorer key={activeWorktreeId ?? 'none'} />}
      {rightSidebarTab === 'search' && <SearchPanel key={activeWorktreeId ?? 'none'} />}
      {rightSidebarTab === 'source-control' && <SourceControl key={activeWorktreeId ?? 'none'} />}
    </div>
  )

  const activityBarIcons = ACTIVITY_ITEMS.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={rightSidebarTab === item.id}
      onClick={() => setRightSidebarTab(item.id)}
      layout={activityBarPosition}
    />
  ))

  return (
    <div
      className="relative flex-shrink-0 flex flex-row overflow-visible transition-[width] duration-200"
      style={{ width: totalWidth }}
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
              {ACTIVITY_ITEMS.find((item) => item.id === rightSidebarTab)?.title ?? ''}
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

// ─── Activity Bar Button (shared for top + side) ──────
function ActivityBarButton({
  item,
  active,
  onClick,
  layout
}: {
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  layout: 'top' | 'side'
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
