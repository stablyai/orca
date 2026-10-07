import type React from 'react'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'
import { useWorktreeLineageTreeStore } from '@/store/worktree-lineage-tree-store'
import { clampWorktreeParentPickerIndex } from './worktree-parent-picker-filtering'

export const FOCUSABLE_ANCHOR_SELECTOR = 'button, [href], input, select, textarea, [tabindex="0"]'

export type SelectParentArgs = {
  childWorktreeId: string | null
  parentWorktreeId: string
  assignWorktreeParent: (worktreeId: string, args: { parentWorktreeId: string }) => Promise<void>
  close: () => void
  showError: (message: string) => void
  onLinked?: (childWorktreeId: string, parentWorktreeId: string) => void
}

export type WorktreeParentPickerKeyboardArgs = {
  event: React.KeyboardEvent<HTMLInputElement>
  candidates: readonly { id: string }[]
  activeIndex: number
  moveHighlight: (index: number) => void
  selectParent: (worktreeId: string) => void
}

export function getWorktreeParentPickerFocusRestoreTarget(
  anchorElement: HTMLElement | null
): HTMLElement | null {
  if (!anchorElement?.isConnected) {
    return null
  }
  return anchorElement.closest<HTMLElement>(FOCUSABLE_ANCHOR_SELECTOR)
}

export function selectWorktreeParent({
  childWorktreeId,
  parentWorktreeId,
  assignWorktreeParent,
  close,
  showError,
  onLinked
}: SelectParentArgs): void {
  if (!childWorktreeId) {
    return
  }
  close()
  void assignWorktreeParent(childWorktreeId, { parentWorktreeId })
    .then(() => {
      useWorktreeLineageTreeStore.getState().openLineageTree({
        worktreeId: childWorktreeId,
        newlyLinkedId: childWorktreeId
      })
      onLinked?.(childWorktreeId, parentWorktreeId)
    })
    .catch((error) => {
      console.error('Failed to set parent worktree:', error)
      showError(
        translate(
          'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
          'Failed to set parent worktree'
        )
      )
    })
}

export function handleWorktreeParentPickerKeyDown({
  event,
  candidates,
  activeIndex,
  moveHighlight,
  selectParent
}: WorktreeParentPickerKeyboardArgs): void {
  if (isImeCompositionKeyDown(event) || candidates.length === 0) {
    return
  }
  const navigate = (nextIndex: number): void => {
    event.preventDefault()
    event.stopPropagation()
    moveHighlight(clampWorktreeParentPickerIndex(nextIndex, candidates.length))
  }
  if (event.key === 'ArrowDown') {
    navigate(activeIndex + 1)
  } else if (event.key === 'ArrowUp') {
    navigate(activeIndex - 1)
  } else if (event.key === 'Home') {
    navigate(0)
  } else if (event.key === 'End') {
    navigate(candidates.length - 1)
  } else if (event.key === 'Enter') {
    const candidate = candidates[activeIndex]
    if (candidate) {
      event.preventDefault()
      event.stopPropagation()
      selectParent(candidate.id)
    }
  }
}
