import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import {
  isElementVisibleInScrollContainer,
  revealElementInScrollContainer
} from '../../worktree-sidebar-reveal'
import { getRenderRowOptionId } from './active-descendant-option'
import { getMountedWorktreeOptions, getWorktreeOptionId } from '../rows/option-dom'
import type { RenderRow } from '../listing/render-row'

// Why: duplicate-in-groups renders one pinned workspace as two rows; a reveal must pick a
// copy the user can already see rather than yank the viewport to the off-screen copy.
export function createVisibleRevealRowPredicate(
  container: HTMLElement | null,
  reveal: Pick<PendingSidebarWorktreeReveal, 'worktreeId' | 'executionHostId'>
): ((row: RenderRow) => boolean) | undefined {
  if (!container) {
    return undefined
  }
  return (row) => {
    const optionId = getRenderRowOptionId(row, reveal.worktreeId, reveal.executionHostId)
    const element = optionId ? document.getElementById(optionId) : null
    return element !== null && isElementVisibleInScrollContainer(container, element)
  }
}

export function revealMountedWorktreeElement(
  container: HTMLElement,
  worktreeId: string,
  behavior: ScrollBehavior,
  optionId?: string,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  const element = optionId
    ? document.getElementById(optionId)
    : getMountedWorktreeOptions(worktreeId, container)[0]
  if (!element || !container.contains(element)) {
    return null
  }
  return revealElementInScrollContainer(container, element, behavior, onScrollIssued)
    ? element
    : null
}

export function revealMountedSidebarRowElement(
  container: HTMLElement,
  rowKey: string,
  behavior: ScrollBehavior,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  const element = document.getElementById(getWorktreeOptionId(rowKey))
  if (!element || !container.contains(element)) {
    return null
  }
  return revealElementInScrollContainer(container, element, behavior, onScrollIssued)
    ? element
    : null
}
