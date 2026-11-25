import React from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { isWorkspaceBoardKeepOpenTarget } from './use-workspace-kanban-outside-dismiss'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../../../../app-shell/chrome/workspace-chrome-metrics'
import { trackSidebarLiveWidth } from '../../chrome/sidebar-live-width'
import { resolveSidebarDrawerLeftEdge } from '../../chrome/sidebar-drawer-left-edge'
import { useAppStore } from '@/store/index'
import { selectAppRailWidth } from '@/components/app-rail/app-rail-layout'

const MIN_DOCKED_BOARD_WIDTH = 320
const BOARD_RIGHT_EDGE = '--workspace-board-right-edge'

function trackWorkspaceBoardBounds(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return
  }

  const stopTrackingSidebar = trackSidebarLiveWidth(element)
  const workspace = element.ownerDocument.querySelector('[data-workspace-shell-content]')
  if (!workspace) {
    return stopTrackingSidebar
  }

  let lastRightEdge: string | null = null
  // Why: ResizeObserver's initial delivery runs before first paint, so no synchronous sync is needed.
  const observer = new ResizeObserver(() => {
    const next = `${workspace.getBoundingClientRect().right}px`
    if (next === lastRightEdge) {
      return
    }
    lastRightEdge = next
    element.style.setProperty(BOARD_RIGHT_EDGE, next)
  })
  observer.observe(workspace)
  return () => {
    observer.disconnect()
    stopTrackingSidebar?.()
  }
}

type WorkspaceKanbanSheetProps = {
  boardRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
  dragPreview: boolean
  leftSidebarStyle?: React.CSSProperties
  onOpenChange: (open: boolean) => void
  open: boolean
  preserveOpenForMenu: boolean
  sidebarOpen: boolean
  sidebarWidth: number
  statusBarVisible: boolean
}

export default function WorkspaceKanbanSheet({
  boardRef,
  children,
  dragPreview,
  leftSidebarStyle,
  onOpenChange,
  open,
  preserveOpenForMenu,
  sidebarOpen,
  sidebarWidth,
  statusBarVisible
}: WorkspaceKanbanSheetProps): React.JSX.Element {
  const railWidth = useAppStore(selectAppRailWidth)
  const { left: drawerLeft, leftCss: drawerLeftCss } = resolveSidebarDrawerLeftEdge({
    sidebarOpen,
    sidebarWidth,
    railWidth
  })
  const panelZoom = 'var(--web-panel-zoom, 1)'
  // The observed right edge and viewport width are viewport pixels; the sheet uses local CSS pixels.
  const dockedWidth = `var(${BOARD_RIGHT_EDGE}, 100vw) / ${panelZoom} - ${drawerLeftCss}`
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`
  const keepOpenForOutsideEvent = (event: {
    preventDefault: () => void
    detail: { originalEvent: Event }
  }): void => {
    const originalEvent = event.detail.originalEvent
    const target = originalEvent.target
    if (preserveOpenForMenu || isWorkspaceBoardKeepOpenTarget(target)) {
      event.preventDefault()
      return
    }
    const liveDrawerLeft =
      boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')?.getBoundingClientRect()
        .left ?? drawerLeft
    const pointerX =
      'clientX' in originalEvent && typeof originalEvent.clientX === 'number'
        ? originalEvent.clientX
        : null
    if (pointerX !== null && pointerX < liveDrawerLeft) {
      event.preventDefault()
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true)
        }
      }}
      modal={false}
    >
      <SheetContent
        side="left"
        showCloseButton={false}
        ref={trackWorkspaceBoardBounds}
        className="workspace-kanban-sheet-content bg-worktree-sidebar p-0 sm:max-w-none"
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          left: drawerLeftCss,
          pointerEvents: 'none'
        }}
        style={{
          ...leftSidebarStyle,
          left: drawerLeftCss,
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          height: 'auto',
          width: `min(max(${dockedWidth}, ${MIN_DOCKED_BOARD_WIDTH}px), 100vw / ${panelZoom} - ${drawerLeftCss}, 1294px)`
        }}
        data-contextual-tour-target="workspace-board-surface"
        data-workspace-board-sheet=""
        data-workspace-board-drag-preview={dragPreview ? 'true' : undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={keepOpenForOutsideEvent}
        onInteractOutside={keepOpenForOutsideEvent}
      >
        {children}
      </SheetContent>
    </Sheet>
  )
}
