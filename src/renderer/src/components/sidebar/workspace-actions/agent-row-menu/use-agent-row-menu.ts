import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/selection/active-workspace'
import type { WorktreeContextMenuModel } from '../context-menu/use-worktree-context-menu-model'
import { isFromWorkspaceAgentRow } from '../context-menu/worktree-context-menu-policy'
import type { AgentRowMenuController, AgentRowMenuOpenRequest } from './agent-row-menu-context'
import {
  AGENT_ROW_MENU_OPEN_ATTR,
  WORKTREE_CARD_MENU_OPEN_ATTR,
  focusAgentRow
} from './agent-row-menu-dom'
import {
  getAgentRowMenuActions,
  resolveAgentRowMenuTarget,
  type AgentRowMenuActions,
  type AgentRowMenuTarget
} from './agent-row-menu-target'

/** How the root menu closed, which decides where focus goes afterwards. */
type AgentRowMenuCloseReason = 'agent-action' | 'restore' | 'outside' | 'other'

export type AgentRowMenuSession = {
  generation: number
  target: AgentRowMenuTarget
  actions: AgentRowMenuActions
  label: string
  row: DashboardAgentRow
  element: HTMLElement
  sidebar: HTMLElement | null
  onActivate: (tabId: string, paneKey: string) => void
}

type OpenArgs = {
  event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>
  anchor: 'pointer' | 'row'
  agent: AgentRowMenuOpenRequest | null
  fromPortal?: boolean
}

/** The sidebar is captured at open so a removed card still restores to its own list. */
function findSidebar(scope: HTMLElement | null): HTMLElement | null {
  const sidebar = scope?.closest('[data-worktree-sidebar]')
  return sidebar instanceof HTMLElement ? sidebar : null
}

export function isActiveWorkspaceForCard(
  state: Pick<
    ReturnType<typeof useAppStore.getState>,
    'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  model: Pick<WorktreeContextMenuModel, 'worktree'>
): boolean {
  return isActiveSidebarWorkspace(model.worktree, {
    worktreeId: state.activeWorktreeId,
    hostId: state.activeWorkspaceExecutionHostId ?? null
  })
}

export function useAgentRowMenu(model: WorktreeContextMenuModel) {
  const modelRef = useRef(model)
  useEffect(() => {
    modelRef.current = model
  })
  const { menuOpen } = model
  const [session, setSession] = useState<AgentRowMenuSession | null>(null)
  const [hideWorkspaceRemoval, setHideWorkspaceRemoval] = useState(false)
  const sessionRef = useRef<AgentRowMenuSession | null>(null)
  const generationRef = useRef(0)
  const menuOpenRef = useRef(false)
  const outlinedRowRef = useRef<HTMLElement | null>(null)
  const closeReasonRef = useRef<AgentRowMenuCloseReason>('other')
  const pendingReasonRef = useRef<AgentRowMenuCloseReason | null>(null)
  const escapeArmedRef = useRef(false)
  const outsideRef = useRef(false)
  useLayoutEffect(() => {
    menuOpenRef.current = menuOpen
  }, [menuOpen])

  const clearOutline = useCallback(() => {
    outlinedRowRef.current?.removeAttribute(AGENT_ROW_MENU_OPEN_ATTR)
    outlinedRowRef.current = null
    modelRef.current.scopeRef.current?.removeAttribute(WORKTREE_CARD_MENU_OPEN_ATTR)
  }, [])

  const openMenu = useCallback(
    ({ event, anchor, agent, fromPortal }: OpenArgs) => {
      const current = modelRef.current
      const scope = current.scopeRef.current
      event.preventDefault()
      current.contextMenuOpenedAtRef.current = anchor === 'pointer' ? Date.now() : null
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
      clearOutline()
      generationRef.current += 1
      pendingReasonRef.current = null
      escapeArmedRef.current = false
      outsideRef.current = false
      closeReasonRef.current = 'other'
      const state = useAppStore.getState()
      const target = agent
        ? resolveAgentRowMenuTarget(state, {
            worktreeId: current.worktree.id,
            cardHostId: current.worktree.hostId,
            paneKey: agent.row.paneKey,
            tabId: agent.row.tab.id
          })
        : null
      // No resolvable agent means no agent item works, so the row falls back to the card menu.
      const next =
        agent && target
          ? {
              generation: generationRef.current,
              target,
              actions: getAgentRowMenuActions(
                state,
                target,
                isActiveWorkspaceForCard(state, current)
              ),
              label: agent.label,
              row: agent.row,
              element: agent.element,
              sidebar: findSidebar(scope),
              onActivate: agent.onActivate
            }
          : null
      sessionRef.current = next
      setSession(next)
      setHideWorkspaceRemoval(
        !next &&
          Boolean(fromPortal || agent || (scope && isFromWorkspaceAgentRow(scope, event.target)))
      )
      current.setDeveloperMenuRevealed(event.altKey)
      current.setContextWorktrees(
        fromPortal
          ? [current.worktree]
          : (current.onContextMenuSelect?.() ?? current.effectiveSelectedWorktrees)
      )
      const bounds = scope?.getBoundingClientRect()
      const left = bounds?.left ?? 0
      const top = bounds?.top ?? 0
      if (anchor === 'row' && agent) {
        const rowBounds = agent.element.getBoundingClientRect()
        current.setMenuPoint({ x: rowBounds.left - left, y: rowBounds.bottom - top })
      } else if ('clientX' in event) {
        current.setMenuPoint({ x: event.clientX - left, y: event.clientY - top })
      }
      if (next) {
        next.element.setAttribute(AGENT_ROW_MENU_OPEN_ATTR, '')
        outlinedRowRef.current = next.element
      } else {
        scope?.setAttribute(WORKTREE_CARD_MENU_OPEN_ATTR, '')
      }
      current.setMenuOpenState(true)
    },
    [clearOutline]
  )

  const controller = useMemo<AgentRowMenuController>(
    () => ({
      open: (request) => openMenu({ event: request.event, anchor: request.anchor, agent: request })
    }),
    [openMenu]
  )

  useEffect(() => {
    if (!menuOpen) {
      clearOutline()
    }
  }, [menuOpen, clearOutline])
  useEffect(() => clearOutline, [clearOutline])

  const agentMenuOpen = menuOpen && session !== null
  useEffect(() => {
    if (!agentMenuOpen) {
      return
    }
    // Window capture runs before Radix's document-level Escape handling, including from submenus.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) {
        return
      }
      escapeArmedRef.current = true
      window.setTimeout(() => {
        escapeArmedRef.current = false
      }, 0)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [agentMenuOpen])

  // Radix-driven root closes are classified here; other closes keep the 'other' reason.
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && sessionRef.current) {
      closeReasonRef.current =
        pendingReasonRef.current ??
        (escapeArmedRef.current ? 'restore' : outsideRef.current ? 'outside' : 'other')
    }
    menuOpenRef.current = open
    modelRef.current.setMenuOpenState(open)
  }, [])

  const handleInteractOutside = useCallback((event: Event) => {
    if (sessionRef.current && !event.defaultPrevented) {
      outsideRef.current = true
    }
  }, [])

  const closeAgentMenu = useCallback((reason: AgentRowMenuCloseReason, generation?: number) => {
    if (
      generation !== undefined &&
      (generation !== generationRef.current || !menuOpenRef.current)
    ) {
      return
    }
    closeReasonRef.current = reason
    modelRef.current.setMenuOpenState(false)
  }, [])

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        !menuOpenRef.current ||
        event.key !== 'Escape' ||
        isImeOwnedKeyboardEvent(event.nativeEvent)
      ) {
        return
      }
      // A focused submenu item can open a tooltip that consumes Radix's first Escape.
      event.preventDefault()
      event.stopPropagation()
      closeAgentMenu('restore')
    },
    [closeAgentMenu]
  )

  const markAgentSelect = useCallback((reason: AgentRowMenuCloseReason) => {
    pendingReasonRef.current = reason
  }, [])

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (menuOpenRef.current) {
      event.preventDefault()
      return
    }
    const current = modelRef.current
    const active = sessionRef.current
    if (!active) {
      current.handleCloseAutoFocus(event)
      return
    }
    sessionRef.current = null
    setSession(null)
    const reason = closeReasonRef.current
    if (reason === 'other') {
      current.handleCloseAutoFocus(event)
      return
    }
    current.handleCloseAutoFocus(event, () => {
      if (
        reason === 'restore' &&
        !focusAgentRow(active.element, active.target.paneKey) &&
        active.sidebar?.isConnected
      ) {
        active.sidebar.focus({ preventScroll: true })
      }
    })
  }, [])

  return {
    session,
    hideWorkspaceRemoval,
    controller,
    openMenu,
    handleOpenChange,
    handleKeyDownCapture,
    handleInteractOutside,
    handleCloseAutoFocus,
    closeAgentMenu,
    markAgentSelect
  }
}

export type AgentRowMenuState = ReturnType<typeof useAgentRowMenu>
