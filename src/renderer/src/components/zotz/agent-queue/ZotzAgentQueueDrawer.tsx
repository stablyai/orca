import { useCallback, useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { trackSidebarLiveWidth } from '@/components/sidebar/sidebar-live-width'
import {
  isWorkspaceBoardKeepOpenTarget,
  useWorkspaceKanbanOutsideDismiss
} from '@/components/sidebar/workspace-board/surface/use-workspace-kanban-outside-dismiss'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '@/components/sidebar/workspace-chrome-metrics'
import { isXtermHelperTextarea } from '@/components/terminal-pane/input/focus/regular-terminal-focus-ownership'
import { navigateResourceSessionToTab } from '@/components/status-bar/resources/session-actions/resource-session-navigation'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { ZotzAgentQueueBoard } from './ZotzAgentQueueBoard'
import { useZotzAgentQueueMachines } from './use-zotz-agent-queue-machines'
import {
  setZotzAgentQueueDrawerOpen,
  useZotzAgentQueueDrawerOpen
} from './zotz-agent-queue-drawer-open'

// Nested overlays own Escape before the drawer; the drawer's own role=dialog is excluded.
const ESCAPE_BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[role="dialog"][data-state="open"]:not([data-zotz-agent-queue-sheet])',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]'
].join(', ')

/** Mounted only while open, so the closed drawer derives nothing. */
function ZotzAgentQueueDrawerBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const machines = useZotzAgentQueueMachines()
  const now = useNow(30_000)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const names = useMemo(
    () =>
      new Map(
        getIndexedAllWorktrees(worktreesByRepo).map((worktree) => [
          worktree.id,
          worktree.displayName
        ])
      ),
    [worktreesByRepo]
  )
  return (
    <ZotzAgentQueueBoard
      machines={machines}
      now={now}
      workspaceName={(worktreeId) => (worktreeId ? (names.get(worktreeId) ?? worktreeId) : '')}
      onOpenPane={(paneKey) => {
        const tabId = parsePaneKey(paneKey)?.tabId
        if (!tabId) {
          return
        }
        onClose()
        const state = useAppStore.getState()
        navigateResourceSessionToTab(tabId, paneKey, {
          tabsByWorktree: state.tabsByWorktree,
          setActiveView: state.setActiveView,
          activateAndRevealWorktree,
          activateTabAndFocusPane
        })
      }}
    />
  )
}

/** The agent queue as a non-modal companion beside the sidebar, like the workspace board. */
export function ZotzAgentQueueDrawer({
  leftSidebarStyle,
  statusBarVisible
}: {
  leftSidebarStyle?: React.CSSProperties
  statusBarVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const open = useZotzAgentQueueDrawerOpen()
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setZotzAgentQueueDrawerOpen(false), [])

  useWorkspaceKanbanOutsideDismiss({
    open,
    boardRef,
    preserveOpenForMenu: false,
    onOpenChange: close
  })

  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector(ESCAPE_BLOCKING_OVERLAY_SELECTOR)) {
        return
      }
      event.preventDefault()
      // xterm ignores defaultPrevented; stop only its Escape so other targets keep theirs.
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
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`

  const guardSidebarInteraction = (
    event: CustomEvent<{ originalEvent: PointerEvent | FocusEvent }>
  ): void => {
    const originalEvent = event.detail.originalEvent
    if (isWorkspaceBoardKeepOpenTarget(originalEvent.target)) {
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
      // Keep the sidebar usable while the board stays open.
      event.preventDefault()
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        // Close only through the guarded Escape, outside and close-button paths.
        if (nextOpen) {
          setZotzAgentQueueDrawerOpen(true)
        }
      }}
      modal={false}
    >
      <SheetContent
        side="sidebarCompanion"
        showCloseButton={false}
        ref={trackSidebarLiveWidth}
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
          width: `min(calc(100vw - ${drawerLeftCss}), 1294px)`
        }}
        data-zotz-agent-queue-sheet=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={guardSidebarInteraction}
        onInteractOutside={guardSidebarInteraction}
      >
        <div className="flex flex-col gap-0.5 border-b border-worktree-sidebar-border px-4 py-3 pr-12">
          <SheetTitle>{t('zotz.agentQueue.board.title', 'Agent queue')}</SheetTitle>
          <SheetDescription>
            {t(
              'zotz.agentQueue.board.description',
              'Each machine has its own memory: its agents start when they fit there, the rest wait their turn.'
            )}
          </SheetDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-2.5 right-3"
          aria-label={t('zotz.agentQueue.board.close', 'Close')}
          onClick={close}
        >
          <X className="size-3.5" />
        </Button>
        <div
          ref={boardRef}
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-3"
          data-zotz-agent-queue-board=""
        >
          {open ? <ZotzAgentQueueDrawerBody onClose={close} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
