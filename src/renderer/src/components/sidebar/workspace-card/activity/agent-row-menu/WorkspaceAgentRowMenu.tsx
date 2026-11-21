import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { DashboardAgentRow as AgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import {
  shouldSuppressContextMenuFollowUpClick,
  shouldUseNativeContextMenu
} from '../../../workspace-actions/context-menu/worktree-context-menu-policy'

export type WorkspaceAgentRowMenuState = {
  /** Anchor, relative to the row. */
  point: { x: number; y: number }
  openedAt: number
  /** Focus to give back on close; a keyboard-opened menu came from a control inside the row. */
  returnFocusTo: HTMLElement | null
}

export type WorkspaceAgentRowMenuHandle = {
  menu: WorkspaceAgentRowMenuState | null
  close: () => void
  /** Spread on the row's root. */
  rowProps: {
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
    'data-agent-row-menu-open': 'true' | undefined
  }
}

/** What a row's click does: open its agent (a worker opens its spawning parent's pane). */
export function activateAgentRow(
  agent: AgentRowData,
  onActivate: (tabId: string, paneKey: string) => void
): void {
  onActivate(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
  void viewClaudeAgentFromRow(agent)
}

/** A row's Agent menu state; nothing is mounted until the row is right-clicked. */
export function useWorkspaceAgentRowMenu(): WorkspaceAgentRowMenuHandle {
  const [menu, setMenu] = useState<WorkspaceAgentRowMenuState | null>(null)
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (shouldUseNativeContextMenu(event.target)) {
      return
    }
    event.preventDefault()
    // A worker row sits inside its parent's row; only the innermost row opens.
    event.stopPropagation()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    const bounds = event.currentTarget.getBoundingClientRect()
    // A keyboard-opened menu reports no pointer position: anchor it under the row's start.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    const active = document.activeElement
    setMenu({
      point: fromKeyboard
        ? { x: 8, y: bounds.height }
        : { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      openedAt: Date.now(),
      returnFocusTo:
        active instanceof HTMLElement && event.currentTarget.contains(active) ? active : null
    })
  }, [])
  const close = useCallback(() => setMenu(null), [])
  return {
    menu,
    close,
    rowProps: { onContextMenu, 'data-agent-row-menu-open': menu ? 'true' : undefined }
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
  if (!handle.menu) {
    return null
  }
  return (
    <AgentRowMenuContent
      menu={handle.menu}
      onClose={handle.close}
      title={title}
      unread={unread}
      // Worker and title-only rows have no read state of their own.
      canToggleRead={agent.rowSource === 'live'}
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
  const openedAtRef = useRef<number | null>(menu.openedAt)
  // The right-button release that opened the menu must not pick the item under it.
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
        onPointerUpCapture={suppressOpeningPointer}
        onMouseUpCapture={suppressOpeningPointer}
        onClickCapture={suppressOpeningPointer}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
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
        <DropdownMenuItem onSelect={() => void window.api.ui.writeClipboardText(title)}>
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
