import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import type { AgentRevealArgs } from '../dashboard-popout/AgentTerminalDialog'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from '../sidebar/use-workspace-kanban-outside-dismiss'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../sidebar/workspace-chrome-metrics'
import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'
import { translate } from '@/i18n/i18n'

// Why: Escape should dismiss interactive nested overlays (e.g. the terminal
// preview dialog) before this companion sheet, which is excluded by its own
// data attribute because Radix marks it role="dialog" as well.
const AGENT_BOARD_ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[role="dialog"][data-state="open"]:not([data-agent-dashboard-sheet])',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]'
].join(', ')

/** The in-window Agent Dashboard body. Mounted only while open so the live
 *  snapshot derivation stays off the hot path when the drawer is closed. */
function AgentDashboardDrawerBody({
  onClose,
  onMenuOpenChange
}: {
  onClose: () => void
  onMenuOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()

  // In-window ack/reveal act on the local store directly — the pop-out's IPC
  // relay is gated to the pop-out renderer and would reject calls from here.
  const handleAckAgent = useCallback((paneKey: string) => {
    useAppStore.getState().acknowledgeAgents([paneKey])
  }, [])
  const handleRevealAgent = useCallback(
    (args: AgentRevealArgs) => {
      useAppStore.getState().setActiveWorktree(args.worktreeId)
      activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
      onClose()
    },
    [onClose]
  )

  // Switching to pop-out from the board hands the surface over rather than
  // leaving an in-window board that the setting says should be a window.
  const handleSwitchToPopout = useCallback(() => {
    onClose()
    void window.api.dashboard.openPopout?.()
  }, [onClose])

  return (
    <AgentKanbanBoard
      snapshot={snapshot}
      // Why: bg-transparent lets the sheet's worktree-sidebar surface through
      // so the board reads as the same companion panel as the workspace board.
      containerClassName="h-full w-full bg-transparent"
      onAckAgent={handleAckAgent}
      onRevealAgent={handleRevealAgent}
      onClose={onClose}
      headerActions={
        <AgentDashboardSettingsMenu
          onSwitchToPopout={handleSwitchToPopout}
          onOpenChange={onMenuOpenChange}
        />
      }
    />
  )
}

type AgentDashboardDrawerProps = {
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}

/**
 * The in-window Agent Dashboard surface: the same board as the pop-out window,
 * presented like the workspace kanban board — a non-modal companion sheet that
 * expands from the sidebar edge and keeps the rest of the app interactive.
 */
export function AgentDashboardDrawer({
  leftSidebarStyle,
  statusBarVisible
}: AgentDashboardDrawerProps): React.JSX.Element {
  const open = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const [menuOpen, setMenuOpen] = useState(false)
  // Why: like closeWorkspaceBoard, reset the menu flag on close — Radix never
  // reports close for a menu unmounted with the sheet (e.g. the pop-out
  // hand-off), and a stale true would block outside-dismiss on reopen.
  const close = useCallback(() => {
    setMenuOpen(false)
    setOpen(false)
  }, [setOpen])
  // Why: sidebar collapse (Cmd+B) and workspace-board exclusivity close the
  // drawer through the store setter, bypassing close(); sync the flag so a
  // menu unmounted that way can't block outside-dismiss on the next open.
  useEffect(() => {
    if (!open) {
      setMenuOpen(false)
    }
  }, [open])
  const handleSheetOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Why: Radix also requests dismissal for unguardable interactions (focus
      // moving outside has no pointer coordinates), so like the workspace board
      // only the drawer's own escape/outside/close paths may close it.
      if (nextOpen) {
        setOpen(true)
      }
    },
    [setOpen]
  )
  const boardRef = useRef<HTMLDivElement | null>(null)

  useWorkspaceKanbanOutsideDismiss({
    open,
    boardRef,
    preserveOpenForMenu: menuOpen,
    onOpenChange: setOpen
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
      close()
    }
    // Why: the board is a non-modal companion panel, so focus may be outside
    // the sheet when Escape should still dismiss it.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [close, open])

  const drawerLeft = sidebarOpen ? sidebarWidth : 0
  const drawerLeftCss = sidebarOpen
    ? `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
    : '0px'
  // Why: App reserves a bottom status row while visible; the portalled board
  // must share that viewport bound instead of covering the status controls.
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`

  const guardSidebarInteraction = (
    event: CustomEvent<{ originalEvent: PointerEvent | FocusEvent }>
  ): void => {
    const originalEvent = event.detail.originalEvent
    if (menuOpen || isWorkspaceBoardKeepOpenTarget(originalEvent.target)) {
      // Why: the first outside click should close a board menu, not also
      // dismiss the board that owns it.
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
          // Why: Radix focuses the first header button on open, which shows
          // hover-style affordances without hover and makes the drawer noisy.
          event.preventDefault()
        }}
        onPointerDownOutside={guardSidebarInteraction}
        onInteractOutside={guardSidebarInteraction}
      >
        <SheetTitle className="sr-only">{translate('dashboardPopout.title', 'Agents')}</SheetTitle>
        {/* Radix unmounts SheetContent while closed, so the live snapshot
            derivation in the body stays off the closed path. */}
        <div ref={boardRef} className="flex min-h-0 flex-1 flex-col">
          <AgentDashboardDrawerBody onClose={close} onMenuOpenChange={setMenuOpen} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
