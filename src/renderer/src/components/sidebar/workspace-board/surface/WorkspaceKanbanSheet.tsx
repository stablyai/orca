import React from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { isWorkspaceBoardKeepOpenTarget } from './use-workspace-kanban-outside-dismiss'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../../../../app-shell/chrome/workspace-chrome-metrics'
import { trackSidebarLiveWidth } from '../../chrome/sidebar-live-width'
import { resolveSidebarDrawerInset } from '../../chrome/sidebar-drawer-inset'
import { useAppStore } from '@/store/index'
import { selectAppRailWidth } from '@/components/app-rail/app-rail-layout'

const MIN_DOCKED_BOARD_WIDTH = 320
const BOARD_CONTENT_WIDTH = '--workspace-board-content-width'

function trackWorkspaceBoardBounds(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return
  }

  const stopTrackingSidebar = trackSidebarLiveWidth(element)
  const workspace = element.ownerDocument.querySelector('[data-workspace-shell-content]')
  if (!workspace) {
    return stopTrackingSidebar
  }

  let lastWidth: string | null = null
  // Why: ResizeObserver's initial delivery runs before first paint, so no synchronous sync is needed.
  const observer = new ResizeObserver(() => {
    const next = `${workspace.getBoundingClientRect().width}px`
    if (next === lastWidth) {
      return
    }
    lastWidth = next
    element.style.setProperty(BOARD_CONTENT_WIDTH, next)
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
  const edge = useAppStore((s) =>
    s.settings?.workspaceSidebarPosition === 'right' ? 'right' : 'left'
  )
  const { inset, insetCss } = resolveSidebarDrawerInset({
    sidebarOpen,
    sidebarWidth,
    railWidth: edge === 'left' ? railWidth : 0
  })
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
    const drawerEdge =
      boardRef.current
        ?.closest<HTMLElement>('[data-slot="sheet-content"]')
        ?.getBoundingClientRect()[edge] ?? (edge === 'left' ? inset : window.innerWidth - inset)
    const pointerX =
      'clientX' in originalEvent && typeof originalEvent.clientX === 'number'
        ? originalEvent.clientX
        : null
    if (pointerX !== null && (edge === 'left' ? pointerX < drawerEdge : pointerX > drawerEdge)) {
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
        side={edge}
        data-workspace-drawer-edge={edge}
        showCloseButton={false}
        ref={trackWorkspaceBoardBounds}
        className="workspace-kanban-sheet-content bg-worktree-sidebar p-0 sm:max-w-none"
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          [edge]: insetCss,
          pointerEvents: 'none'
        }}
        style={{
          ...leftSidebarStyle,
          [edge]: insetCss,
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          height: 'auto',
          width: `min(max(var(${BOARD_CONTENT_WIDTH}, 100vw), ${MIN_DOCKED_BOARD_WIDTH}px), 100vw - ${insetCss}, 1294px)`
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
