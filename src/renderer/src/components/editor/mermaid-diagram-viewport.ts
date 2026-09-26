export type DiagramTransform = { x: number; y: number; scale: number }
export type DiagramSize = { width: number; height: number }
export type DiagramPoint = { x: number; y: number }

export const MIN_DIAGRAM_SCALE = 0.1
export const MAX_DIAGRAM_SCALE = 8
export const DIAGRAM_BUTTON_ZOOM_STEP = 1.25
export const DIAGRAM_KEY_PAN_STEP = 80
const DIAGRAM_KEY_PAN_FAST_MULTIPLIER = 4
// Why: small diagrams would otherwise balloon to fill the whole screen on open.
const MAX_FIT_SCALE = 2
const FIT_PADDING = 32
const WHEEL_ZOOM_SENSITIVITY = 0.0015
const WHEEL_LINE_HEIGHT_PX = 16
const WHEEL_PAGE_HEIGHT_PX = 800

export function clampDiagramScale(scale: number, minScale = MIN_DIAGRAM_SCALE): number {
  return Math.min(MAX_DIAGRAM_SCALE, Math.max(minScale, scale))
}

/** Lowest allowed zoom for a diagram; drops below the default so huge diagrams still fit whole. */
export function diagramMinScale(fitScale: number): number {
  return Math.min(MIN_DIAGRAM_SCALE, fitScale)
}

/** Centers the diagram in the viewport at the largest scale that fits it whole. */
export function fitDiagramTransform(content: DiagramSize, viewport: DiagramSize): DiagramTransform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 }
  }
  const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2)
  const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2)
  // Why: no lower clamp — a very large diagram may need less than MIN_DIAGRAM_SCALE to fit whole.
  const scale = Math.min(
    availableWidth / content.width,
    availableHeight / content.height,
    MAX_FIT_SCALE
  )
  return {
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
    scale
  }
}

export function isSameDiagramTransform(a: DiagramTransform, b: DiagramTransform): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale
}

/** Zooms to `nextScale` while keeping the diagram point under `anchor` fixed on screen. */
export function zoomDiagramAt(
  transform: DiagramTransform,
  nextScale: number,
  anchor: DiagramPoint,
  minScale = MIN_DIAGRAM_SCALE
): DiagramTransform {
  const scale = clampDiagramScale(nextScale, minScale)
  const ratio = scale / transform.scale
  return {
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
    scale
  }
}

/** Multiplicative zoom factor for a wheel event; exponential so trackpads and wheels feel alike. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  return Math.exp(-wheelDeltaPixels(deltaY, deltaMode) * WHEEL_ZOOM_SENSITIVITY)
}

// Why: deltaMode 1 reports lines (Firefox-style mouse wheels) and 2 reports pages, not pixels.
function wheelDeltaPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) {
    return deltaY * WHEEL_LINE_HEIGHT_PX
  }
  if (deltaMode === 2) {
    return deltaY * WHEEL_PAGE_HEIGHT_PX
  }
  return deltaY
}

export type DiagramKeyAction =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'fit' }

/** Maps a viewer keypress to a view change; arrows move the view like scrolling (Shift = bigger steps). */
export function diagramKeyAction(key: string, shiftKey: boolean): DiagramKeyAction | null {
  const step = DIAGRAM_KEY_PAN_STEP * (shiftKey ? DIAGRAM_KEY_PAN_FAST_MULTIPLIER : 1)
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'pan', dx: step, dy: 0 }
    case 'ArrowRight':
      return { kind: 'pan', dx: -step, dy: 0 }
    case 'ArrowUp':
      return { kind: 'pan', dx: 0, dy: step }
    case 'ArrowDown':
      return { kind: 'pan', dx: 0, dy: -step }
    // Why: '=' shares the '+' key on US layouts, so it zooms in without Shift.
    case '+':
    case '=':
      return { kind: 'zoom', factor: DIAGRAM_BUTTON_ZOOM_STEP }
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / DIAGRAM_BUTTON_ZOOM_STEP }
    case '0':
      return { kind: 'fit' }
    default:
      return null
  }
}
