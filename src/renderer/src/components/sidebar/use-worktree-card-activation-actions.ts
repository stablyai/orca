import React, { useCallback, useLayoutEffect, useRef } from 'react'

import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { isEditableTarget } from '@/lib/editable-target'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import {
  afterPointerGestureEnds,
  isEventTargetInsideCurrentTarget,
  isPlainPrimaryMousePress,
  isSelectableTextTarget
} from './worktree-card-dom-events'
import { canActivateWorktreeOnPress } from './worktree-press-activation-eligibility'
import { isSidebarPointerDragBlocked } from './worktree-sidebar-pointer-drag-dom'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>

export function useWorktreeCardActivationActions({
  worktree,
  repo,
  affiliateListMode,
  onSelectionGesture,
  isActive,
  activationRowKey,
  onActivate,
  activateOnPress,
  onWorktreeCardClick,
  onImmediateActivate,
  isDeleting,
  isSshDisconnected,
  updateWorktreeMeta,
  setWorkspaceUnreadByUser,
  openModal
}: Pick<
  WorktreeCardProps,
  | 'worktree'
  | 'repo'
  | 'affiliateListMode'
  | 'onSelectionGesture'
  | 'isActive'
  | 'activationRowKey'
  | 'onActivate'
  | 'activateOnPress'
  | 'onWorktreeCardClick'
  | 'onImmediateActivate'
> &
  Pick<
    Foundation,
    'isSshDisconnected' | 'updateWorktreeMeta' | 'setWorkspaceUnreadByUser' | 'openModal'
  > &
  Pick<LinkedDetails, 'isDeleting'>) {
  const worktreeRef = useRef(worktree)
  useLayoutEffect(() => {
    worktreeRef.current = worktree
  }, [worktree])
  const pressActivatedRef = useRef(false)
  const focusBeforePressRef = useRef<Element | null>(null)
  const activate = useCallback(() => {
    onWorktreeCardClick?.()
    // Use shared activation so sidebar navigation participates in back/forward history.
    recordRendererCrashBreadcrumb('sidebar_worktree_activate', {
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      wasActive: isActive,
      sshDisconnected: isSshDisconnected
    })
    onImmediateActivate?.(worktree.id, activationRowKey)
    void activateWorktreeFromSidebar(
      worktree.id,
      worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
    )
    onActivate?.()
  }, [
    worktree.id,
    worktree.repoId,
    worktree.hostId,
    repo,
    isActive,
    activationRowKey,
    isSshDisconnected,
    onActivate,
    onWorktreeCardClick,
    onImmediateActivate
  ])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      const pressActivated = pressActivatedRef.current
      pressActivatedRef.current = false
      // Synthetic option-forwarded clicks report detail 0 and must still activate.
      if (pressActivated && event.detail > 0) {
        return
      }
      const selection = window.getSelection()
      // Why: only suppress the click for a selection inside this card; a foreign selection must not block worktree switching.
      if (selection && selection.toString().length > 0) {
        const card = event.currentTarget
        const anchor = selection.anchorNode
        const focus = selection.focusNode
        const selectionInsideCard =
          (anchor instanceof Node && card.contains(anchor)) ||
          (focus instanceof Node && card.contains(focus))
        if (selectionInsideCard) {
          return
        }
      }
      const selectionOnly = affiliateListMode
        ? false
        : (onSelectionGesture?.(event, worktreeRef.current) ?? false)
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (isDeleting) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      activate()
    },
    [affiliateListMode, isDeleting, onSelectionGesture, activate]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pressActivatedRef.current = false
      if (
        !activateOnPress ||
        isDeleting ||
        !isPlainPrimaryMousePress(event) ||
        !isEventTargetInsideCurrentTarget(event.currentTarget, event.target) ||
        isSidebarPointerDragBlocked(event.target, event.currentTarget) ||
        isSelectableTextTarget(event.target) ||
        // The press prevents mousedown's focus move, so an open edit would keep the keystrokes.
        isEditableTarget(document.activeElement) ||
        // A closing menu or dialog restores focus after the press and would take it from the new workspace.
        hasVisibleOverlay() ||
        !canActivateWorktreeOnPress({
          worktreeId: worktree.id,
          rowHostId: worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
        })
      ) {
        return
      }
      // A plain press replaces the selection exactly as the click would before navigating.
      if (onSelectionGesture?.(event, worktreeRef.current)) {
        return
      }
      pressActivatedRef.current = true
      focusBeforePressRef.current = document.activeElement
      // Drag suppression can swallow this gesture's click; the flag must not outlive it and skip a later click.
      afterPointerGestureEnds(() => {
        pressActivatedRef.current = false
        focusBeforePressRef.current = null
      })
      activate()
    },
    [activateOnPress, isDeleting, onSelectionGesture, activate, worktree.id, worktree.hostId, repo]
  )

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // When the press already focused the new workspace, the native default would move focus to the list.
    if (pressActivatedRef.current && document.activeElement !== focusBeforePressRef.current) {
      event.preventDefault()
    }
  }, [])

  const handleRenameTitle = useCallback(
    // Store logging/refetch reverts failed optimistic renames; inline rename has no separate error surface.
    async (displayName: string): Promise<void> => {
      await updateWorktreeMeta(
        worktree.id,
        { displayName },
        { executionHostId: worktree.hostId ?? 'local' }
      )
    },
    [updateWorktreeMeta, worktree.hostId, worktree.id]
  )

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (affiliateListMode) {
        return
      }
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        executionHostId: worktree.hostId,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment
      })
    },
    [
      openModal,
      affiliateListMode,
      worktree.comment,
      worktree.displayName,
      worktree.hostId,
      worktree.id,
      worktree.linkedIssue,
      worktree.linkedPR,
      worktree.repoId
    ]
  )

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setWorkspaceUnreadByUser(worktree.id, !worktree.isUnread, worktree.hostId ?? 'local')
    },
    [worktree.hostId, worktree.id, worktree.isUnread, setWorkspaceUnreadByUser]
  )

  return {
    handleClick,
    handlePointerDown,
    handleMouseDown,
    handleRenameTitle,
    handleDoubleClick,
    handleToggleUnreadQuick
  }
}
