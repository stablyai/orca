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

// Park after enough still frames to tolerate dropped animation frames without polling indefinitely.
const MOTION_SETTLE_FRAMES = 12
// Probe eventless movement at 4Hz if IntersectionObserver cannot wake the tracker.
const PARKED_PROBE_MS = 250

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

// Keep arrow placement outside the panel’s matching border so their outlines remain continuous.
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
    // Match hosted absolute/floating fixed CSS; apply offsetParent-relative coordinates without subtracting the host again.
    strategy: args.panelHost ? 'absolute' : 'fixed',
    placement: initialPlacement,
    middleware: [
      offset(PANEL_GAP),
      flip({
        boundary,
        padding: COLLISION_PADDING,
        fallbackPlacements: FALLBACK_PLACEMENTS[initialPlacement]
      }),
      // Allow target overlap when nothing fits so host overflow clipping cannot hide panel buttons.
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
  let lastDelivered: ContextualTourFloatingPosition | null = null
  const update = (): void => {
    const sequence = ++updateSequence
    void getContextualTourFloatingPosition(args)
      .then((position) => {
        // Ignore async positions from disposed trackers or superseded frames.
        if (disposed || sequence !== updateSequence) {
          return
        }
        // Suppress unchanged positions; ancestor scroll recomputes must not trigger React commits.
        if (arePositionsEqual(lastDelivered, position)) {
          return
        }
        lastDelivered = position
        args.onPosition(position)
      })
      .catch(() => undefined)
  }

  const tracker = createTargetMotionTracker(args.targetElement, update)
  // Observers wake frame tracking only during motion; animationFrame:true would poll throughout the tour’s life.
  const stopAutoUpdate = autoUpdate(args.targetElement, args.floatingElement, () => {
    update()
    tracker.wake()
  })
  return () => {
    disposed = true
    tracker.stop()
    stopAutoUpdate()
  }
}

type TargetMotionTracker = { wake: () => void; stop: () => void }

// Why: parked between movements, per-frame only while the target is moving.
function createTargetMotionTracker(target: Element, onMove: () => void): TargetMotionTracker {
  let frameId: number | null = null
  let probeTimer: number | null = null
  let stopped = false
  let settledFrames = 0
  let lastRect = target.getBoundingClientRect()

  const park = (): void => {
    if (stopped || probeTimer !== null) {
      return
    }
    probeTimer = window.setTimeout(() => {
      probeTimer = null
      if (readMovement()) {
        onMove()
        startTracking()
        return
      }
      park()
    }, PARKED_PROBE_MS)
  }

  const readMovement = (): boolean => {
    const rect = target.getBoundingClientRect()
    const moved = !rectsMatch(lastRect, rect)
    lastRect = rect
    return moved
  }

  const trackFrame = (): void => {
    frameId = null
    if (stopped) {
      return
    }
    if (readMovement()) {
      settledFrames = 0
      onMove()
    } else {
      settledFrames += 1
    }
    if (settledFrames >= MOTION_SETTLE_FRAMES) {
      park()
      return
    }
    frameId = requestAnimationFrame(trackFrame)
  }

  const startTracking = (): void => {
    settledFrames = 0
    if (stopped || frameId !== null) {
      return
    }
    if (probeTimer !== null) {
      window.clearTimeout(probeTimer)
      probeTimer = null
    }
    frameId = requestAnimationFrame(trackFrame)
  }

  startTracking()
  return {
    wake: startTracking,
    stop: () => {
      stopped = true
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
        frameId = null
      }
      if (probeTimer !== null) {
        window.clearTimeout(probeTimer)
        probeTimer = null
      }
    }
  }
}

function rectsMatch(a: DOMRect, b: DOMRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

function arePositionsEqual(
  a: ContextualTourFloatingPosition | null,
  b: ContextualTourFloatingPosition
): boolean {
  return (
    a !== null &&
    a.panelPlacement === b.panelPlacement &&
    a.panelPosition.left === b.panelPosition.left &&
    a.panelPosition.top === b.panelPosition.top &&
    a.arrowPosition.left === b.arrowPosition.left &&
    a.arrowPosition.top === b.arrowPosition.top
  )
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
