export type EmulatorScreenPoint = {
  x: number
  y: number
}

export type EmulatorGesturePoint = EmulatorScreenPoint & {
  edge?: number
  type: 'begin' | 'move' | 'end'
}

export type PointerSample = {
  clientX: number
  clientY: number
}

export type WheelSample = PointerSample & {
  deltaMode?: number
  deltaX: number
  deltaY: number
}

type RectLike = {
  left: number
  top: number
  width: number
  height: number
}

type StreamSize = {
  width: number
  height: number
} | null

export type EmulatorPointerAction =
  | { kind: 'tap'; point: EmulatorScreenPoint }
  | { kind: 'gesture'; points: EmulatorGesturePoint[] }

type ContentRect = RectLike

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
export const HID_EDGE_BOTTOM = 3
const HOME_INDICATOR_BAND_NORM = 0.93

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function clampEmulatorScreenPoint(point: EmulatorScreenPoint): EmulatorScreenPoint {
  return { x: clampUnit(point.x), y: clampUnit(point.y) }
}

export function resolveEmulatorHomeIndicatorEdge(point: EmulatorScreenPoint): number | undefined {
  return point.y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : undefined
}

export function buildEmulatorGesturePoint(
  point: EmulatorScreenPoint,
  type: EmulatorGesturePoint['type'],
  edge?: number
): EmulatorGesturePoint {
  return edge === undefined ? { ...point, type } : { ...point, type, edge }
}

function resolveSimulatorScreenContentRect(rect: RectLike, streamSize: StreamSize): ContentRect {
  let contentLeft = rect.left
  let contentTop = rect.top
  let contentWidth = rect.width
  let contentHeight = rect.height
  if (streamSize) {
    const frameAspect = rect.width / rect.height
    const streamAspect = streamSize.width / streamSize.height
    if (frameAspect > streamAspect) {
      contentWidth = rect.height * streamAspect
      contentLeft += (rect.width - contentWidth) / 2
    } else if (frameAspect < streamAspect) {
      contentHeight = rect.width / streamAspect
      contentTop += (rect.height - contentHeight) / 2
    }
  }
  return { left: contentLeft, top: contentTop, width: contentWidth, height: contentHeight }
}

function normalizeWheelDelta(
  delta: number,
  deltaMode: number | undefined,
  pageSize: number
): number {
  if (deltaMode === DOM_DELTA_LINE) {
    return delta * 16
  }
  if (deltaMode === DOM_DELTA_PAGE) {
    return delta * pageSize
  }
  return delta
}

export function mapClientPointToSimulatorScreen(
  sample: PointerSample,
  rect: RectLike,
  streamSize: StreamSize
): EmulatorScreenPoint | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const {
    left: contentLeft,
    top: contentTop,
    width: contentWidth,
    height: contentHeight
  } = resolveSimulatorScreenContentRect(rect, streamSize)
  const x = (sample.clientX - contentLeft) / contentWidth
  const y = (sample.clientY - contentTop) / contentHeight
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null
  }
  return { x, y }
}

export function resolveEmulatorPointerAction(
  samples: PointerSample[],
  rect: RectLike,
  streamSize: StreamSize,
  dragThresholdPx = 8
): EmulatorPointerAction | null {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) {
    return null
  }
  const firstPoint = mapClientPointToSimulatorScreen(first, rect, streamSize)
  const lastPoint = mapClientPointToSimulatorScreen(last, rect, streamSize)
  if (!firstPoint || !lastPoint) {
    return null
  }
  const maxDistance = samples.reduce((max, sample) => {
    const dx = sample.clientX - first.clientX
    const dy = sample.clientY - first.clientY
    return Math.max(max, Math.hypot(dx, dy))
  }, 0)
  if (maxDistance < dragThresholdPx) {
    return { kind: 'tap', point: lastPoint }
  }

  const edge = resolveEmulatorHomeIndicatorEdge(firstPoint)
  const middle = samples.slice(1, -1)
  const points: EmulatorGesturePoint[] = [buildEmulatorGesturePoint(firstPoint, 'begin', edge)]
  for (const sample of middle) {
    const point = mapClientPointToSimulatorScreen(sample, rect, streamSize)
    if (point) {
      points.push(buildEmulatorGesturePoint(point, 'move', edge))
    }
  }
  points.push(buildEmulatorGesturePoint(lastPoint, 'end', edge))
  return { kind: 'gesture', points }
}

export function resolveEmulatorWheelDelta(
  sample: WheelSample,
  rect: RectLike,
  streamSize: StreamSize,
  sensitivity = 1.2
): { start: EmulatorScreenPoint; delta: EmulatorScreenPoint } | null {
  const start = mapClientPointToSimulatorScreen(sample, rect, streamSize)
  if (!start) {
    return null
  }
  const contentRect = resolveSimulatorScreenContentRect(rect, streamSize)
  if (contentRect.width <= 0 || contentRect.height <= 0) {
    return null
  }
  const deltaX = normalizeWheelDelta(sample.deltaX, sample.deltaMode, contentRect.width)
  const deltaY = normalizeWheelDelta(sample.deltaY, sample.deltaMode, contentRect.height)
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return null
  }
  return {
    start,
    // Why: wheel deltas describe content scroll direction, while iOS HID input
    // needs the opposite finger movement that produces that scroll.
    delta: {
      x: (-deltaX / contentRect.width) * sensitivity,
      y: (-deltaY / contentRect.height) * sensitivity
    }
  }
}

export function buildWheelGesturePoints(
  start: EmulatorScreenPoint,
  end: EmulatorScreenPoint,
  minDistance = 0.01
): EmulatorGesturePoint[] | null {
  const clampedEnd = clampEmulatorScreenPoint(end)
  if (Math.hypot(clampedEnd.x - start.x, clampedEnd.y - start.y) < minDistance) {
    return null
  }
  return [
    { ...start, type: 'begin' },
    { x: (start.x + clampedEnd.x) / 2, y: (start.y + clampedEnd.y) / 2, type: 'move' },
    { ...clampedEnd, type: 'end' }
  ]
}
