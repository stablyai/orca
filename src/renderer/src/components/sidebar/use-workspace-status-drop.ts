import { useEffect } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import type { WorkspacePinTarget } from '../../store/slices/worktree-helpers'
import {
  hasWorkspaceDragData,
  readWorkspaceDragDataIds,
  readWorkspaceDragDataTargets,
  WORKSPACE_STATUS_DRAG_TARGETS_TYPE
} from './workspace-status'

const WORKSPACE_STATUS_DROP_TARGET = '[data-workspace-status-drop-target]'
const WORKSPACE_PIN_DROP_TARGET = '[data-workspace-pin-drop-target]'

type MoveWorktreeToStatus = (worktreeId: string, status: WorkspaceStatus) => void
type MoveWorktreesToStatus = (worktreeIds: readonly string[], status: WorkspaceStatus) => void
type PinWorktree = (target: WorkspacePinTarget) => void
type PinWorktrees = (targets: readonly WorkspacePinTarget[]) => void

type WorkspaceStatusDocumentDropOptions = {
  onMoveWorktreesToStatus?: MoveWorktreesToStatus
  onPinWorktrees?: PinWorktrees
}

export function commitWorkspaceStatusDocumentDrop(params: {
  worktreeIds: readonly string[]
  pinTargets?: readonly WorkspacePinTarget[]
  status: WorkspaceStatus | null
  isPinDrop: boolean
  onMoveWorktreeToStatus: MoveWorktreeToStatus
  onMoveWorktreesToStatus?: MoveWorktreesToStatus
  onPinWorktree: PinWorktree
  onPinWorktrees?: PinWorktrees
}): void {
  const {
    worktreeIds,
    pinTargets,
    status,
    isPinDrop,
    onMoveWorktreeToStatus,
    onMoveWorktreesToStatus,
    onPinWorktree,
    onPinWorktrees
  } = params

  if (isPinDrop) {
    const targets = pinTargets ?? worktreeIds
    if (targets.length === 0) {
      return
    }
    if (onPinWorktrees) {
      onPinWorktrees(targets)
      return
    }
    for (const target of targets) {
      onPinWorktree(target)
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

      const pinTargets = readWorkspaceDragDataTargets(dataTransfer)
      const hasPinTargetPayload = Array.from(dataTransfer.types).includes(
        WORKSPACE_STATUS_DRAG_TARGETS_TYPE
      )
      const worktreeIds = readWorkspaceDragDataIds(dataTransfer)
      const pinTargetIds = pinTargets?.map((target) =>
        typeof target === 'string' ? target : target.worktreeId
      )
      const effectiveWorktreeIds = worktreeIds.length > 0 ? worktreeIds : (pinTargetIds ?? [])
      if (effectiveWorktreeIds.length === 0) {
        return
      }

      // Why: Electron's preload bridge stops native drops before React sees
      // them, so board drops commit from this scoped capture listener.
      event.preventDefault()
      event.stopPropagation()
      commitWorkspaceStatusDocumentDrop({
        worktreeIds: effectiveWorktreeIds,
        pinTargets:
          dropTarget === pinTarget
            ? hasPinTargetPayload
              ? (pinTargets ?? [])
              : undefined
            : undefined,
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
