import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { SetupSplitDirection } from '../../../../../shared/worktree/launch-types'

const SPLIT_GEOMETRY_EPSILON_PX = 1

export function readElementRect(element: HTMLElement | null | undefined): DOMRect | null {
  try {
    return element?.getBoundingClientRect?.() ?? null
  } catch {
    return null
  }
}

export function hasVisibleRect(rect: DOMRect | null): rect is DOMRect {
  return Boolean(
    rect && rect.width > SPLIT_GEOMETRY_EPSILON_PX && rect.height > SPLIT_GEOMETRY_EPSILON_PX
  )
}

export function readProposedPaneGrid(pane: ManagedPane): { cols: number; rows: number } | null {
  try {
    const dimensions = pane.fitAddon.proposeDimensions()
    if (!dimensions || dimensions.cols <= 0 || dimensions.rows <= 0) {
      return null
    }
    return dimensions
  } catch {
    return null
  }
}

export function isPaneGridAlignedWithFit(pane: ManagedPane): boolean {
  const proposed = readProposedPaneGrid(pane)
  return Boolean(
    proposed && pane.terminal.cols === proposed.cols && pane.terminal.rows === proposed.rows
  )
}

export function isSetupSplitGeometryReady(
  pane: ManagedPane,
  manager: PaneManager,
  direction: SetupSplitDirection
): boolean {
  const splitElement = pane.container.parentElement
  const directionClass = direction === 'vertical' ? 'is-vertical' : 'is-horizontal'
  if (
    !splitElement?.classList?.contains('pane-split') ||
    !splitElement.classList.contains(directionClass)
  ) {
    return false
  }

  const sibling = manager
    .getPanes()
    .find(
      (candidate) => candidate.id !== pane.id && candidate.container.parentElement === splitElement
    )
  const splitRect = readElementRect(splitElement)
  const paneRect = readElementRect(pane.container)
  const siblingRect = readElementRect(sibling?.container)
  if (!hasVisibleRect(splitRect) || !hasVisibleRect(paneRect) || !hasVisibleRect(siblingRect)) {
    return false
  }

  const splitAxis = direction === 'vertical' ? splitRect.width : splitRect.height
  const paneAxis = direction === 'vertical' ? paneRect.width : paneRect.height
  const siblingAxis = direction === 'vertical' ? siblingRect.width : siblingRect.height
  return (
    paneAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    siblingAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    splitAxis - paneAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    splitAxis - siblingAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    isPaneGridAlignedWithFit(pane)
  )
}
