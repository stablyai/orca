import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { isXtermHelperTextarea } from '../terminal-pane/regular-terminal-focus-ownership'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from '../sidebar/use-workspace-kanban-outside-dismiss'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../sidebar/workspace-chrome-metrics'
import { translate } from '@/i18n/i18n'
import { AgentDashboardDrawerBody } from './AgentDashboardDrawerBody'

// Nested interactive overlays own Escape before the companion sheet; exclude the sheet’s own role=dialog marker.
const AGENT_BOARD_ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[role="dialog"][data-state="open"]:not([data-agent-dashboard-sheet])',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]'
].join(', ')

type AgentDashboardDrawerProps = {
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}

/** Share the pop-out board in a non-modal sidebar companion sheet, leaving the rest of the app interactive. */
export function AgentDashboardDrawer({
  leftSidebarStyle,
  statusBarVisible
}: AgentDashboardDrawerProps): React.JSX.Element {
  const open = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const [menuOpen, setMenuOpen] = useState(false)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const focusReturnRef = useRef<{ opener: HTMLElement | null; handoff: boolean }>({
    opener: null,
    handoff: false
  })

  // Capture per open transition: a reopen during the exit animation reuses the Sheet without open autofocus.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const focusReturn = focusReturnRef.current
    focusReturn.handoff = false
    const active = document.activeElement
    if (!boardRef.current?.closest('[data-slot="sheet-content"]')?.contains(active)) {
      focusReturn.opener = active instanceof HTMLElement && active !== document.body ? active : null
    }
  }, [open])

  // No Radix trigger exists for this store-driven drawer, so return focus only when unmount dropped it to body.
  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
    const { opener, handoff } = focusReturnRef.current
    if (!handoff && (!document.activeElement || document.activeElement === document.body)) {
      opener?.focus({ preventScroll: true })
    }
  }, [])
  // Radix does not report close for unmounted menus; reset or the next drawer open could block outside dismissal.
  const close = useCallback(() => {
    setMenuOpen(false)
    setOpen(false)
  }, [setOpen])
  // Outside dismissal, agent reveal and pop-out move focus themselves.
  const closeForFocusHandoff = useCallback(() => {
    focusReturnRef.current.handoff = true
    close()
  }, [close])
  // Store-driven closes bypass close(); clear menu state for sidebar collapse and workspace-board exclusivity too.
  useEffect(() => {
    if (!open) {
      setMenuOpen(false)
    }
  }, [open])
  const handleSheetOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Radix can request coordinate-free dismissal; allow only the drawer’s guarded Escape/outside/close paths.
      if (nextOpen) {
        setOpen(true)
      }
    },
    [setOpen]
  )
  useWorkspaceKanbanOutsideDismiss({
    open,
    boardRef,
    preserveOpenForMenu: menuOpen,
    onOpenChange: closeForFocusHandoff
  })

  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      if (document.querySelector(AGENT_BOARD_ESCAPE_BLOCKING_OVERLAY_SELECTOR)) {
        return
      }
      event.preventDefault()
      // xterm ignores defaultPrevented; stop only its Escape so other targets keep theirs (rename/drag cancel).
      if (isXtermHelperTextarea(event.target)) {
        event.stopPropagation()
      }
      close()
    }
    // The non-modal drawer must hear Escape even when focus is outside it.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [close, open])

  const drawerLeft = sidebarOpen ? sidebarWidth : 0
  const drawerLeftCss = sidebarOpen
    ? `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
    : '0px'
  // Reserve the same status-row space as App so the portal cannot cover its controls.
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`

  const guardSidebarInteraction = (
    event: CustomEvent<{ originalEvent: PointerEvent | FocusEvent }>
  ): void => {
    const originalEvent = event.detail.originalEvent
    if (menuOpen || isWorkspaceBoardKeepOpenTarget(originalEvent.target)) {
      // The first outside click dismisses the board menu only.
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
      // Why: keep the workspace sidebar interactive while the companion board stays open.
      event.preventDefault()
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        aria-describedby={undefined}
        className="workspace-kanban-sheet-content bg-worktree-sidebar p-0 sm:max-w-none"
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          left: drawerLeftCss,
          pointerEvents: 'none'
        }}
        style={
          {
            ...leftSidebarStyle,
            // Why: the board is a companion to the workspace sidebar, so it
            // expands from the sidebar edge instead of covering the sidebar.
            left: drawerLeftCss,
            top: WORKSPACE_TOP_CHROME_HEIGHT,
            bottom: drawerBottom,
            height: 'auto',
            width: `min(calc(100vw - ${drawerLeftCss}), 1294px)`
          } as React.CSSProperties
        }
        data-agent-dashboard-sheet=""
        onOpenAutoFocus={(event) => {
          // Suppress default header focus, which reveals hover-style affordances without a pointer.
          event.preventDefault()
        }}
        onCloseAutoFocus={handleCloseAutoFocus}
        onPointerDownOutside={guardSidebarInteraction}
        onInteractOutside={guardSidebarInteraction}
      >
        <SheetTitle className="sr-only">{translate('dashboardPopout.title', 'Agents')}</SheetTitle>
        {/* Closed SheetContent unmounts the live snapshot body, avoiding closed-path derivation. */}
        <div ref={boardRef} className="flex min-h-0 flex-1 flex-col">
          <AgentDashboardDrawerBody
            onClose={close}
            onFocusHandoff={closeForFocusHandoff}
            onMenuOpenChange={setMenuOpen}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
