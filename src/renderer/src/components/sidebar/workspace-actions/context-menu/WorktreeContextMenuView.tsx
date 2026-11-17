import { useId } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import { isEventTargetInsideCurrentTarget } from '../../workspace-card/controller/worktree-card-dom-events'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { WorktreeContextMenuOverlays } from './WorktreeContextMenuOverlays'
import { WorktreeContextMenuItems } from './WorktreeContextMenuItems'
import {
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  WorktreeContextMenuPortalScope,
  isOwnedWorktreeContextMenuPortal,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldUseNativeContextMenu
} from './worktree-context-menu-policy'
import { AgentRowMenuContext } from '../agent-row-menu/agent-row-menu-context'
import { isAgentRowMenuTarget } from '../agent-row-menu/agent-row-menu-dom'
import { useAgentRowMenu } from '../agent-row-menu/use-agent-row-menu'
import { AgentRowMenuItems } from '../agent-row-menu/AgentRowMenuItems'

export default function WorktreeContextMenuView({ model }: { model: WorktreeContextMenuModel }) {
  const {
    children,
    contentClassName,
    contextMenuOpenedAtRef,
    menuOpen,
    menuPoint,
    scopeRef,
    suppressOpeningPointerEvent
  } = model
  const agentMenu = useAgentRowMenu(model)
  const { session } = agentMenu
  const t = useTranslate()
  const portalScope = useId()
  return (
    <div
      ref={scopeRef}
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
          return
        }
        if (shouldUseNativeContextMenu(event.target)) {
          return
        }
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        // Marked agent rows open their own menu (or fall back to this one) from their handler.
        if (isAgentRowMenuTarget(event.target)) {
          return
        }
        agentMenu.openMenu({ event, anchor: 'pointer', agent: null })
      }}
      onContextMenu={(event) => {
        // The hover card handles selected-text Copy before its agent rows fall back to this menu.
        if (
          !event.defaultPrevented &&
          isOwnedWorktreeContextMenuPortal(event.target, portalScope)
        ) {
          event.stopPropagation()
          agentMenu.openMenu({ event, anchor: 'pointer', agent: null, fromPortal: true })
        }
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      <WorktreeContextMenuPortalScope value={portalScope}>
        <AgentRowMenuContext value={agentMenu.controller}>{children}</AgentRowMenuContext>
      </WorktreeContextMenuPortalScope>
      <DropdownMenu open={menuOpen} onOpenChange={agentMenu.handleOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn('min-w-52', contentClassName)}
          sideOffset={0}
          align="start"
          onPointerUpCapture={suppressOpeningPointerEvent}
          onPointerDownCapture={(event) => {
            if (event.button === 0) {
              contextMenuOpenedAtRef.current = null
            }
          }}
          onMouseUpCapture={suppressOpeningPointerEvent}
          onClickCapture={suppressOpeningPointerEvent}
          onKeyDownCapture={session ? agentMenu.handleKeyDownCapture : undefined}
          onCloseAutoFocus={agentMenu.handleCloseAutoFocus}
          onInteractOutside={agentMenu.handleInteractOutside}
          {...(session && {
            'aria-labelledby': undefined,
            'aria-label': t('components.sidebar.agentRowMenu.ariaLabel', 'Agent: {{name}}', {
              name: session.label
            })
          })}
        >
          {session ? (
            <AgentRowMenuItems
              key={session.generation}
              model={model}
              menu={agentMenu}
              session={session}
            />
          ) : (
            <WorktreeContextMenuItems
              model={model}
              hideWorkspaceRemoval={agentMenu.hideWorkspaceRemoval}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <WorktreeContextMenuOverlays model={model} />
    </div>
  )
}
