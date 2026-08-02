import {
  arrow,
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Boundary,
  type Placement
} from '@floating-ui/dom'
import type { CSSProperties } from 'react'
import type { ContextualTourStepPlacement } from '../../../../shared/contextual-tours'

export type ContextualTourPanelPlacement = 'top' | 'right' | 'bottom' | 'left'

export type ContextualTourFloatingPosition = {
  arrowPosition: CSSProperties
  panelPlacement: ContextualTourPanelPlacement
  panelPosition: CSSProperties
}

const PANEL_GAP = 12
const COLLISION_PADDING = 12
const ARROW_PADDING = 16
const ARROW_WIDTH = 18
const ARROW_HEIGHT = 8

const FALLBACK_PLACEMENTS = {
  top: ['bottom', 'right', 'left'],
  right: ['left', 'bottom', 'top'],
  bottom: ['top', 'right', 'left'],
  left: ['right', 'bottom', 'top']
} satisfies Record<ContextualTourPanelPlacement, ContextualTourPanelPlacement[]>

export const CONTEXTUAL_TOUR_ARROW_SIZE = {
  width: ARROW_WIDTH,
  height: ARROW_HEIGHT
} as const

// Why: keep the arrow just outside the panel border. Letting it overlap the
// border makes the callout look like it is colliding with the tip card outline.
export const CONTEXTUAL_TOUR_PANEL_BORDER_WIDTH = 1

export async function getContextualTourFloatingPosition(args: {
  arrowElement: Element
  floatingElement: HTMLElement
  panelHost: HTMLElement | null
  preferredPlacement?: ContextualTourStepPlacement
  targetElement: Element
}): Promise<ContextualTourFloatingPosition> {
  const initialPlacement = args.preferredPlacement ?? 'right'
  const boundary = getContextualTourCollisionBoundary(args.panelHost)
  const result = await computePosition(args.targetElement, args.floatingElement, {
    // Why: the strategy must match the panel's actual CSS position — hosted
    // panels are absolute children of the dialog/sheet, floating ones fixed.
    // computePosition returns coordinates relative to the panel's offsetParent,
    // so the result is applied to left/top as-is in both cases.
    strategy: args.panelHost ? 'absolute' : 'fixed',
    placement: initialPlacement,
    middleware: [
      offset(PANEL_GAP),
      flip({
        boundary,
        padding: COLLISION_PADDING,
        fallbackPlacements: FALLBACK_PLACEMENTS[initialPlacement]
      }),
      // Why: crossAxis lets the panel slide over the target when no placement
      // fits (e.g. a tall step panel inside a small dialog host) — a partial
      // overlap keeps the panel's buttons reachable instead of letting the
      // host's overflow clipping cut them off.
      shift({ boundary, padding: COLLISION_PADDING, crossAxis: true }),
      arrow({ element: args.arrowElement, padding: ARROW_PADDING })
    ]
  })

  const panelPlacement = getContextualTourPanelPlacement(result.placement)
  const panelPosition: CSSProperties = { left: result.x, top: result.y }
  const arrowPosition = getContextualTourArrowPosition({
    arrowX: result.middlewareData.arrow?.x,
    arrowY: result.middlewareData.arrow?.y,
    panelPlacement
  })

  return { arrowPosition, panelPlacement, panelPosition }
}

export function watchContextualTourFloatingPosition(args: {
  arrowElement: Element
  floatingElement: HTMLElement
  panelHost: HTMLElement | null
  preferredPlacement?: ContextualTourStepPlacement
  targetElement: Element
  onPosition: (position: ContextualTourFloatingPosition) => void
}): () => void {
  let disposed = false
  let updateSequence = 0
  const update = (): void => {
    const sequence = ++updateSequence
    void getContextualTourFloatingPosition(args)
      .then((position) => {
        // Why: computePosition is async; a stale resolve after dispose or a
        // newer frame must not overwrite the latest panel position.
        if (!disposed && sequence === updateSequence) {
          args.onPosition(position)
        }
      })
      .catch(() => undefined)
  }
  // Why: tour targets move with layout animation (sidebar slide, pane resize),
  // which scroll/resize observers can't see. Frame-loop tracking keeps the
  // panel glued to its target instead of polling and re-showing it.
  const stopAutoUpdate = autoUpdate(args.targetElement, args.floatingElement, update, {
    animationFrame: true
  })
  return () => {
    disposed = true
    stopAutoUpdate()
  }
}

function getContextualTourCollisionBoundary(panelHost: HTMLElement | null): Boundary {
  return panelHost ?? 'clippingAncestors'
}

function getContextualTourPanelPlacement(placement: Placement): ContextualTourPanelPlacement {
  return placement.split('-')[0] as ContextualTourPanelPlacement
}

function getContextualTourArrowPosition(args: {
  arrowX?: number
  arrowY?: number
  panelPlacement: ContextualTourPanelPlacement
}): CSSProperties {
  const staticSide = {
    top: 'bottom',
    right: 'left',
    bottom: 'top',
    left: 'right'
  }[args.panelPlacement]
  return {
    left: args.arrowX,
    top: args.arrowY,
    [staticSide]: -ARROW_HEIGHT
  }
}
