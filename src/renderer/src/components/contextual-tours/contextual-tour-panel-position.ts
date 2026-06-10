export type ContextualTourPanelPlacement = 'top' | 'right' | 'bottom' | 'left'

export type ContextualTourPanelPosition = {
  left: number
  top: number
  placement: ContextualTourPanelPlacement
  arrowOffset: number
}

type ViewportSize = {
  width: number
  height: number
}

type PanelSize = {
  width: number
  height: number
}

/**
 * Computes the position and placement for a tour panel relative to a target element,
 * choosing the best side and clamping the panel within the viewport.
 */
export function clampContextualTourPanelPosition(args: {
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
  viewport: ViewportSize
  panel: PanelSize
  preferredPlacement?: ContextualTourPanelPlacement
  gap?: number
  margin?: number
}): ContextualTourPanelPosition {
  const gap = args.gap ?? 12
  const margin = args.margin ?? 12
  const { targetRect, viewport, panel } = args
  const roomRight = viewport.width - targetRect.right
  const roomLeft = targetRect.left
  const roomBelow = viewport.height - targetRect.bottom
  const roomAbove = targetRect.top

  let placement: ContextualTourPanelPlacement
  let left: number
  let top: number
  if (args.preferredPlacement) {
    placement = args.preferredPlacement
    const preferredPosition = getUnclampedPanelPosition({
      placement,
      targetRect,
      panel,
      gap
    })
    left = preferredPosition.left
    top = preferredPosition.top
  } else if (roomRight >= panel.width + gap || roomRight >= roomLeft) {
    placement = 'right'
    left = targetRect.right + gap
    top = targetRect.top + targetRect.height / 2 - panel.height / 2
  } else {
    placement = 'left'
    left = targetRect.left - panel.width - gap
    top = targetRect.top + targetRect.height / 2 - panel.height / 2
  }

  if (roomRight < panel.width + gap && roomLeft < panel.width + gap) {
    left = targetRect.left + targetRect.width / 2 - panel.width / 2
    if (roomBelow >= panel.height + gap || roomBelow >= roomAbove) {
      placement = 'bottom'
      top = targetRect.bottom + gap
    } else {
      placement = 'top'
      top = targetRect.top - panel.height - gap
    }
  }

  const clampedLeft = clampNumber(
    left,
    margin,
    Math.max(margin, viewport.width - panel.width - margin)
  )
  const clampedTop = clampNumber(
    top,
    margin,
    Math.max(margin, viewport.height - panel.height - margin)
  )

  // Arrow offset along the panel edge, pointed at the target's center.
  const targetCenterX = targetRect.left + targetRect.width / 2
  const targetCenterY = targetRect.top + targetRect.height / 2
  const arrowMargin = 16
  const arrowOffset =
    placement === 'top' || placement === 'bottom'
      ? clampNumber(targetCenterX - clampedLeft, arrowMargin, panel.width - arrowMargin)
      : clampNumber(targetCenterY - clampedTop, arrowMargin, panel.height - arrowMargin)

  return { left: clampedLeft, top: clampedTop, placement, arrowOffset }
}

/** Returns the raw (unclamped) top-left position for a panel at the given placement side. */
function getUnclampedPanelPosition(args: {
  placement: ContextualTourPanelPlacement
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
  panel: PanelSize
  gap: number
}): Pick<ContextualTourPanelPosition, 'left' | 'top'> {
  const { placement, targetRect, panel, gap } = args
  if (placement === 'top') {
    return {
      left: targetRect.left + targetRect.width / 2 - panel.width / 2,
      top: targetRect.top - panel.height - gap
    }
  }
  if (placement === 'bottom') {
    return {
      left: targetRect.left + targetRect.width / 2 - panel.width / 2,
      top: targetRect.bottom + gap
    }
  }
  if (placement === 'left') {
    return {
      left: targetRect.left - panel.width - gap,
      top: targetRect.top + targetRect.height / 2 - panel.height / 2
    }
  }
  return {
    left: targetRect.right + gap,
    top: targetRect.top + targetRect.height / 2 - panel.height / 2
  }
}

/** Translates a target rect from viewport coordinates into the host element's local coordinate space. */
export function getContextualTourTargetRectInHost(
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  hostRect: Pick<DOMRect, 'left' | 'top'>
): Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'> {
  return {
    left: targetRect.left - hostRect.left,
    right: targetRect.right - hostRect.left,
    top: targetRect.top - hostRect.top,
    bottom: targetRect.bottom - hostRect.top,
    width: targetRect.width,
    height: targetRect.height
  }
}

/** Clamps a number between min and max, inclusive. */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
