import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Bell, BellOff, Copy, PanelRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { agentMenuLabels } from '@/components/agent/menu/agent-menu-labels'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { viewClaudeAgentFromRow } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { readAgentAttentionTurnStartedAt } from '@/attention/agent-attention-acknowledgement'
import { AgentRowsShownContext } from './agent-rows-shown-context'
import type { DashboardAgentRow as AgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import {
  shouldSuppressContextMenuFollowUpClick,
  shouldUseNativeContextMenu
} from '../../../workspace-actions/context-menu/worktree-context-menu-policy'

export type WorkspaceAgentRowMenuState = {
  /** Anchor, relative to the row. */
  point: { x: number; y: number }
  openedAt: number
  /** Opened by the menu key or Shift+F10: no opening pointer release to swallow. */
  fromKeyboard: boolean
  /** Focus to give back on close; a keyboard-opened menu came from a control inside the row. */
  returnFocusTo: HTMLElement | null
}

export type WorkspaceAgentRowMenuHandle = {
  menu: WorkspaceAgentRowMenuState | null
  close: () => void
  /** Spread on the row's root. */
  rowProps: {
    onPointerDownCapture: () => void
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
    'data-agent-row-menu-open': 'true' | undefined
  }
}

/** Longest press-to-menu gap of a pointer opening (a touch long press is the slow one). */
const POINTER_OPEN_AFTER_PRESS_MS = 2_000

/** What a row's click does: open its agent (a worker opens its spawning parent's pane). */
export function activateAgentRow(
  agent: AgentRowData,
  onActivate: (tabId: string, paneKey: string) => void
): void {
  onActivate(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
  void viewClaudeAgentFromRow(agent)
}

/**
 * React sends events from the row's portaled menu through the row's handlers too.
 * Row click handlers check this so a menu click never acts as a click on the row.
 */
export function isEventInsideRowElement(event: React.SyntheticEvent<HTMLElement>): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target)
}

/** A row's Agent menu state; nothing is mounted until the row is right-clicked. */
export function useWorkspaceAgentRowMenu(): WorkspaceAgentRowMenuHandle {
  const [menu, setMenu] = useState<WorkspaceAgentRowMenuState | null>(null)
  const pressedAtRef = useRef<number | null>(null)
  const onPointerDownCapture = useCallback(() => {
    pressedAtRef.current = Date.now()
  }, [])
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (shouldUseNativeContextMenu(event.target)) {
      return
    }
    event.preventDefault()
    // A worker row sits inside its parent's row; only the innermost row opens.
    event.stopPropagation()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    const bounds = event.currentTarget.getBoundingClientRect()
    // A pointer opening follows a press on the row: macOS opens on the press, Windows on the
    // release, touch after a long press. The menu key and Shift+F10 press nothing, and their
    // event coordinates are not reliable, so that opening is anchored under the row's start.
    const pressedAt = pressedAtRef.current
    const fromKeyboard = pressedAt === null || Date.now() - pressedAt > POINTER_OPEN_AFTER_PRESS_MS
    const active = document.activeElement
    setMenu({
      point: fromKeyboard
        ? { x: 8, y: bounds.height }
        : { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      openedAt: Date.now(),
      fromKeyboard,
      returnFocusTo:
        active instanceof HTMLElement && event.currentTarget.contains(active) ? active : null
    })
  }, [])
  const close = useCallback(() => setMenu(null), [])
  return {
    menu,
    close,
    rowProps: {
      onPointerDownCapture,
      onContextMenu,
      'data-agent-row-menu-open': menu ? 'true' : undefined
    }
  }
}

/** The row's Agent menu while it is open; renders nothing otherwise. */
export function WorkspaceAgentRowMenu({
  handle,
  agent,
  title,
  unread,
  viewing,
  onActivate
}: {
  handle: WorkspaceAgentRowMenuHandle
  agent: AgentRowData
  /** The row's title alone, without its agent name. */
  title: string
  unread: boolean
  /** The row is the agent being viewed (its focused-pane highlight). */
  viewing: boolean
  onActivate: (tabId: string, paneKey: string) => void
}): React.JSX.Element | null {
  const rowsShown = useContext(AgentRowsShownContext)
  const { menu, close } = handle
  // A collapsed list keeps its rows mounted but hidden: their menu closes with them.
  useEffect(() => {
    if (!rowsShown && menu) {
      close()
    }
  }, [rowsShown, menu, close])
  if (!menu || !rowsShown) {
    return null
  }
  return (
    <OpenAgentRowMenu
      menu={menu}
      onClose={close}
      agent={agent}
      title={title}
      unread={unread}
      viewing={viewing}
      onActivate={onActivate}
    />
  )
}

/** Mounted only while the menu is open, so closed rows never subscribe to the store. */
function OpenAgentRowMenu({
  menu,
  onClose,
  agent,
  title,
  unread,
  viewing,
  onActivate
}: {
  menu: WorkspaceAgentRowMenuState
  onClose: () => void
  agent: AgentRowData
  title: string
  unread: boolean
  viewing: boolean
  onActivate: (tabId: string, paneKey: string) => void
}): React.JSX.Element {
  // Read state lives on the pane's live turn. Worker rows and title-only rows have none,
  // so marking them read or unread would change nothing the row shows.
  const hasReadState = useAppStore(
    (state) =>
      agent.rowSource === 'live' &&
      readAgentAttentionTurnStartedAt({ liveTurns: state.agentStatusByPaneKey }, agent.paneKey) !==
        null
  )
  return (
    <AgentRowMenuContent
      menu={menu}
      onClose={onClose}
      title={title}
      unread={unread}
      canToggleRead={hasReadState}
      canMarkUnread={!viewing}
      paneKey={agent.paneKey}
      onOpen={() => activateAgentRow(agent, onActivate)}
    />
  )
}

export function AgentRowMenuContent({
  menu,
  onClose,
  title,
  unread,
  canToggleRead,
  canMarkUnread,
  paneKey,
  onOpen
}: {
  menu: WorkspaceAgentRowMenuState
  onClose: () => void
  /** The row's title alone, without its agent name. */
  title: string
  unread: boolean
  /** False for rows with no read state of their own (worker and title-only rows). */
  canToggleRead: boolean
  /** False on the agent being viewed: it would read again at once. */
  canMarkUnread: boolean
  /** The row's own agent; read state is per agent, as on Activity rows. */
  paneKey: string
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const labels = agentMenuLabels(t)
  const pointerOpenedAt = menu.fromKeyboard ? null : menu.openedAt
  const openedAtRef = useRef<number | null>(pointerOpenedAt)
  const dismissedOutsideRef = useRef(false)
  // A right-click on the row while the menu is open reopens it in place: re-arm for that gesture.
  useEffect(() => {
    openedAtRef.current = pointerOpenedAt
    dismissedOutsideRef.current = false
  }, [pointerOpenedAt, menu.openedAt])
  // The pointer release that opened the menu must not pick the item under it.
  const suppressOpeningPointer = (event: React.SyntheticEvent): void => {
    const openedAt = openedAtRef.current
    if (openedAt === null) {
      return
    }
    if (!shouldSuppressContextMenuFollowUpClick(openedAt, Date.now())) {
      openedAtRef.current = null
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  useEffect(() => {
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, onClose)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, onClose)
  }, [onClose])

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute size-px opacity-0"
          style={{ left: menu.point.x, top: menu.point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-44"
        sideOffset={0}
        align="start"
        // Clicks inside the menu must not reach the row and open the agent a second time.
        onClick={(event) => event.stopPropagation()}
        onPointerDownCapture={(event) => {
          if (event.button === 0) {
            openedAtRef.current = null
          }
        }}
        // A key pressed in the menu is a choice, not the opening gesture (Enter selects with a click).
        onKeyDownCapture={() => {
          openedAtRef.current = null
        }}
        onPointerUpCapture={suppressOpeningPointer}
        onMouseUpCapture={suppressOpeningPointer}
        onClickCapture={suppressOpeningPointer}
        onInteractOutside={() => {
          dismissedOutsideRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // Closed by a click or focus elsewhere: that target keeps focus.
          if (dismissedOutsideRef.current) {
            return
          }
          // Something already took focus as the menu closed (Open moved it to the agent).
          const active = document.activeElement
          if (active && active !== document.body) {
            return
          }
          if (menu.returnFocusTo?.isConnected) {
            menu.returnFocusTo.focus({ preventScroll: true })
          }
        }}
      >
        <DropdownMenuLabel>{labels.section}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onOpen}>
          <PanelRight className="size-3.5" />
          {labels.open}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          // A row with no title shows a state label instead; there is no title to copy.
          disabled={!title.trim()}
          onSelect={() => void window.api.ui.writeClipboardText(title)}
        >
          <Copy className="size-3.5" />
          {labels.copyTitle}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canToggleRead || (!unread && !canMarkUnread)}
          onSelect={() =>
            unread
              ? useAppStore.getState().acknowledgeAgents([paneKey], undefined, 'explicit')
              : useAppStore.getState().unacknowledgeAgents([paneKey])
          }
        >
          {unread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          {unread ? labels.markRead : labels.markUnread}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
