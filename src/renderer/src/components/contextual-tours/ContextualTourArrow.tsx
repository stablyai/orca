import type { CSSProperties, JSX, RefObject } from 'react'
import {
  CONTEXTUAL_TOUR_ARROW_SIZE,
  CONTEXTUAL_TOUR_PANEL_BORDER_WIDTH,
  type ContextualTourPanelPlacement
} from './contextual-tour-floating-position'

const ARROW_WIDTH = CONTEXTUAL_TOUR_ARROW_SIZE.width
const ARROW_HEIGHT = CONTEXTUAL_TOUR_ARROW_SIZE.height

// Why: CSS rotation pivots on the svg center, so horizontal placements must
// also shift by (width - height) / 2 to keep the rotated arrow flush with the
// panel edge instead of half-swallowed by it.
const PLACEMENT_TRANSFORM = {
  top: 'rotate(0deg)',
  bottom: 'rotate(180deg)',
  left: `translateX(${(ARROW_WIDTH - ARROW_HEIGHT) / 2}px) rotate(-90deg)`,
  right: `translateX(${(ARROW_HEIGHT - ARROW_WIDTH) / 2}px) rotate(90deg)`
} satisfies Record<ContextualTourPanelPlacement, string>

export function ContextualTourArrow({
  arrowRef,
  placement,
  style
}: {
  arrowRef: RefObject<SVGSVGElement | null>
  placement: ContextualTourPanelPlacement
  style: CSSProperties
}): JSX.Element {
  return (
    <svg
      ref={arrowRef}
      aria-hidden="true"
      width={ARROW_WIDTH}
      height={ARROW_HEIGHT}
      viewBox={`0 0 ${ARROW_WIDTH} ${ARROW_HEIGHT}`}
      className="absolute block overflow-visible fill-(--contextual-tour-panel-surface) stroke-(--contextual-tour-panel-border)"
      style={{ ...style, transform: PLACEMENT_TRANSFORM[placement] }}
    >
      {/* Why: an open path fills as a triangle but strokes only the two slanted
          edges; a closed polygon (Radix Arrow) also strokes the base, drawing a
          seam across the panel border. Stroke width must match the 1px panel
          border so the outline reads as continuous. */}
      <path
        d={`M0,0 L${ARROW_WIDTH / 2},${ARROW_HEIGHT} L${ARROW_WIDTH},0`}
        strokeWidth={CONTEXTUAL_TOUR_PANEL_BORDER_WIDTH}
      />
    </svg>
  )
}
