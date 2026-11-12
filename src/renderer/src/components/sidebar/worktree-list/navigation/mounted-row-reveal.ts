import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getRevealBoundsVisibility,
  getRevealTargetBounds,
  revealElementInScrollContainer
} from './worktree-sidebar-reveal'
import { getMountedWorktreeOptions, getWorktreeOptionId } from '../rows/option-dom'

// Pinned duplicates render twice; an on-screen copy beats jumping to its off-screen twin (#24852).
export function findOnScreenWorktreeOption(
  container: HTMLElement,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  preferredOptionId: string | undefined
): HTMLElement | undefined {
  const identity = executionHostId && composeWorktreeHostIdentity(executionHostId, worktreeId)
  let fullyVisible: HTMLElement | undefined
  let partlyVisible: HTMLElement | undefined
  for (const option of getMountedWorktreeOptions(worktreeId, container)) {
    if (identity && option.dataset.worktreeHostIdentity !== identity) {
      continue
    }
    const bounds = getRevealTargetBounds(container, option)
    const visibility = bounds ? getRevealBoundsVisibility(container, bounds) : 'hidden'
    if (visibility === 'full') {
      if (option.id === preferredOptionId) {
        return option
      }
      fullyVisible ??= option
    } else if (visibility === 'partial') {
      partlyVisible ??= option
    }
  }
  return fullyVisible ?? partlyVisible
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
