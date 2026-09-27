import {
  revealElementInScrollContainer,
  stopSidebarRevealScroll
} from '../../worktree-sidebar-reveal'
import { getMountedWorktreeOptions, getWorktreeOptionId } from '../rows/option-dom'

function revealMountedElement(
  container: HTMLElement,
  element: HTMLElement | null | undefined,
  behavior: ScrollBehavior,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  if (!element || !container.contains(element)) {
    return null
  }
  let issuedScroll = false
  const revealed = revealElementInScrollContainer(container, element, behavior, (targetTop) => {
    issuedScroll = true
    onScrollIssued?.(targetTop)
  })
  if (revealed && !issuedScroll) {
    // A visible replacement must stop the previous request's native animation.
    stopSidebarRevealScroll(container, onScrollIssued)
  }
  return revealed ? element : null
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
  return revealMountedElement(container, element, behavior, onScrollIssued)
}

export function revealMountedSidebarRowElement(
  container: HTMLElement,
  rowKey: string,
  behavior: ScrollBehavior,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  const element = document.getElementById(getWorktreeOptionId(rowKey))
  return revealMountedElement(container, element, behavior, onScrollIssued)
}
