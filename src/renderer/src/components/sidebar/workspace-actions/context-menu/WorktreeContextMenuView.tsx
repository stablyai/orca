import React, { useId, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { isEventTargetInsideCurrentTarget } from '../../workspace-card/controller/worktree-card-dom-events'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import {
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  WorktreeContextMenuPortalScope,
  isFromWorkspaceAgentRow,
  isOwnedWorktreeContextMenuPortal,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldUseNativeContextMenu
} from './worktree-context-menu-policy'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'

const LazyWorktreeContextMenuPopup = lazyWithRetry(
  () =>
    import('./WorktreeContextMenuPopup').then((module) => ({
      default: module.WorktreeContextMenuPopup
    })),
  { reloadKey: 'worktree-context-menu-popup' }
)

export default function WorktreeContextMenuView({ model }: { model: WorktreeContextMenuModel }) {
  const {
    children,
    contextMenuOpenedAtRef,
    effectiveSelectedWorktrees,
    menuOpen,
    onContextMenuSelect,
    scopeRef,
    setContextWorktrees,
    setDeveloperMenuRevealed,
    setMenuOpenState,
    setMenuPoint,
    suppressOpeningPointerEvent,
    worktree
  } = model
  const portalScope = useId()
  const [openedFromAgentRow, setOpenedFromAgentRow] = useState(false)
  const hasOpenedPopup = useLatchedOpen(
    menuOpen || model.createGroupDialogOpen || Boolean(model.parentPicker)
  )

  function openContextMenu(event: React.MouseEvent<HTMLDivElement>, fromPortal = false): void {
    event.preventDefault()
    contextMenuOpenedAtRef.current = Date.now()
    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    setDeveloperMenuRevealed(event.altKey)
    setOpenedFromAgentRow(fromPortal || isFromWorkspaceAgentRow(event.currentTarget, event.target))
    setContextWorktrees(
      fromPortal ? [worktree] : (onContextMenuSelect?.(event) ?? effectiveSelectedWorktrees)
    )
    const bounds = event.currentTarget.getBoundingClientRect()
    setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    setMenuOpenState(true)
  }

  return (
    <div
      ref={scopeRef}
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (
          !isEventTargetInsideCurrentTarget(event.currentTarget, event.target) ||
          shouldUseNativeContextMenu(event.target) ||
          shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)
        ) {
          return
        }
        openContextMenu(event)
      }}
      onContextMenu={(event) => {
        // Portaled rows let the hover's selected-text Copy handler capture first.
        if (
          !event.defaultPrevented &&
          isOwnedWorktreeContextMenuPortal(event.target, portalScope)
        ) {
          event.stopPropagation()
          openContextMenu(event, true)
        }
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      <WorktreeContextMenuPortalScope.Provider value={portalScope}>
        {children}
      </WorktreeContextMenuPortalScope.Provider>
      {hasOpenedPopup ? (
        <React.Suspense fallback={null}>
          <LazyWorktreeContextMenuPopup model={model} openedFromAgentRow={openedFromAgentRow} />
        </React.Suspense>
      ) : null}
    </div>
  )
}
