import type React from 'react'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { clampWorktreeParentPickerIndex } from './worktree-parent-picker-filtering'

type WorktreeParentPickerKeyboardArgs = {
  event: React.KeyboardEvent<HTMLInputElement>
  candidates: readonly { id: string }[]
  activeIndex: number
  moveHighlight: (index: number) => void
  selectParent: (worktreeId: string) => void
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
