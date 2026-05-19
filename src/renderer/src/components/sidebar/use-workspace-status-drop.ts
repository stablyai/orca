import { useEffect } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../shared/types'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from './workspace-status'

const WORKSPACE_STATUS_DROP_TARGET = '[data-workspace-status-drop-target]'
const WORKSPACE_PIN_DROP_TARGET = '[data-workspace-pin-drop-target]'

type MoveWorktreeToStatus = (worktreeId: string, status: WorkspaceStatus) => void
type MoveWorktreesToStatus = (worktreeIds: readonly string[], status: WorkspaceStatus) => void
type PinWorktree = (worktreeId: string) => void
type PinWorktrees = (worktreeIds: readonly string[]) => void

type WorkspaceStatusDocumentDropOptions = {
  onMoveWorktreesToStatus?: MoveWorktreesToStatus
  onPinWorktrees?: PinWorktrees
}

export function commitWorkspaceStatusDocumentDrop(params: {
  worktreeIds: readonly string[]
  status: WorkspaceStatus | null
  isPinDrop: boolean
  onMoveWorktreeToStatus: MoveWorktreeToStatus
  onMoveWorktreesToStatus?: MoveWorktreesToStatus
  onPinWorktree: PinWorktree
  onPinWorktrees?: PinWorktrees
}): void {
  const {
    worktreeIds,
    status,
    isPinDrop,
    onMoveWorktreeToStatus,
    onMoveWorktreesToStatus,
    onPinWorktree,
    onPinWorktrees
  } = params

  if (isPinDrop) {
    if (onPinWorktrees) {
      onPinWorktrees(worktreeIds)
      return
    }
    for (const worktreeId of worktreeIds) {
      onPinWorktree(worktreeId)
    }
    return
  }

  if (!status) {
    return
  }

  if (onMoveWorktreesToStatus) {
    onMoveWorktreesToStatus(worktreeIds, status)
    return
  }

  for (const worktreeId of worktreeIds) {
    onMoveWorktreeToStatus(worktreeId, status)
  }
}

export function useWorkspaceStatusDocumentDrop<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
  onMoveWorktreeToStatus: MoveWorktreeToStatus,
  onPinWorktree: PinWorktree,
  onDragFinish: () => void,
  enabled = true,
  options?: WorkspaceStatusDocumentDropOptions
): void {
  const { onMoveWorktreesToStatus, onPinWorktrees } = options ?? {}

  useEffect(() => {
    if (!enabled) {
      return
    }

    const handleDrop = (event: DragEvent): void => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer || !hasWorkspaceDragData(dataTransfer)) {
        return
      }

      onDragFinish()

      const container = containerRef.current
      const target = event.target
      if (!container || !(target instanceof Element) || !container.contains(target)) {
        return
      }

      const pinTarget = target.closest<HTMLElement>(WORKSPACE_PIN_DROP_TARGET)
      const statusTarget = target.closest<HTMLElement>(WORKSPACE_STATUS_DROP_TARGET)
      const dropTarget =
        pinTarget && container.contains(pinTarget)
          ? pinTarget
          : statusTarget && container.contains(statusTarget)
            ? statusTarget
            : null
      if (!dropTarget) {
        return
      }

      const worktreeIds = readWorkspaceDragDataIds(dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }

      // Why: Electron's preload bridge stops native drops before React sees
      // them, so board drops commit from this scoped capture listener.
      event.preventDefault()
      event.stopPropagation()
      commitWorkspaceStatusDocumentDrop({
        worktreeIds,
        status: dropTarget.dataset.workspaceStatus ?? null,
        isPinDrop: dropTarget === pinTarget,
        onMoveWorktreeToStatus,
        onMoveWorktreesToStatus,
        onPinWorktree,
        onPinWorktrees
      })
    }

    const handleDragFinish = (): void => {
      onDragFinish()
    }

    document.addEventListener('drop', handleDrop, true)
    document.addEventListener('dragend', handleDragFinish, true)
    return () => {
      document.removeEventListener('drop', handleDrop, true)
      document.removeEventListener('dragend', handleDragFinish, true)
    }
  }, [
    containerRef,
    enabled,
    onDragFinish,
    onMoveWorktreeToStatus,
    onMoveWorktreesToStatus,
    onPinWorktree,
    onPinWorktrees
  ])
}
