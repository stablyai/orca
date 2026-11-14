import type { VisualStreamGeometry } from './emulator-device-frame-layout'

type StreamRotation = VisualStreamGeometry['streamRotation']

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

export function resolveEmulatorHomeIndicatorEdge(
  point: EmulatorScreenPoint,
  rotation: StreamRotation = 0
): number | undefined {
  if (rotation === 90) {
    return point.x >= HOME_INDICATOR_BAND_NORM ? 4 : undefined
  }
  if (rotation === -90) {
    return point.x <= 1 - HOME_INDICATOR_BAND_NORM ? 1 : undefined
  }
  if (rotation === 180) {
    return point.y <= 1 - HOME_INDICATOR_BAND_NORM ? 2 : undefined
  }
  return point.y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : undefined
}

function inverseRotateVector(
  point: EmulatorScreenPoint,
  rotation: StreamRotation
): EmulatorScreenPoint {
  if (rotation === 90) {
    return { x: point.y, y: -point.x }
  }
  if (rotation === -90) {
    return { x: -point.y, y: point.x }
  }
  if (rotation === 180) {
    return { x: -point.x, y: -point.y }
  }
  return point
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
  streamSize: StreamSize,
  rotation: StreamRotation = 0
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
  if (rotation === 90) {
    return { x: y, y: 1 - x }
  }
  if (rotation === -90) {
    return { x: 1 - y, y: x }
  }
  if (rotation === 180) {
    return { x: 1 - x, y: 1 - y }
  }
  return { x, y }
}

export function resolveEmulatorPointerAction(
  samples: PointerSample[],
  rect: RectLike,
  streamSize: StreamSize,
  dragThresholdPx = 8,
  rotation: StreamRotation = 0
): EmulatorPointerAction | null {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) {
    return null
  }
  const firstPoint = mapClientPointToSimulatorScreen(first, rect, streamSize, rotation)
  const lastPoint = mapClientPointToSimulatorScreen(last, rect, streamSize, rotation)
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

  const edge = resolveEmulatorHomeIndicatorEdge(firstPoint, rotation)
  const middle = samples.slice(1, -1)
  const points: EmulatorGesturePoint[] = [buildEmulatorGesturePoint(firstPoint, 'begin', edge)]
  for (const sample of middle) {
    const point = mapClientPointToSimulatorScreen(sample, rect, streamSize, rotation)
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
  sensitivity = 1.2,
  rotation: StreamRotation = 0
): { start: EmulatorScreenPoint; delta: EmulatorScreenPoint } | null {
  const start = mapClientPointToSimulatorScreen(sample, rect, streamSize, rotation)
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
    // Wheel scroll direction is opposite the finger motion iOS HID needs to produce it.
    delta: inverseRotateVector(
      {
        x: (-deltaX / contentRect.width) * sensitivity,
        y: (-deltaY / contentRect.height) * sensitivity
      },
      rotation
    )
  }
}

export function resolveWheelGestureStep(
  point: EmulatorScreenPoint,
  delta: EmulatorScreenPoint
): { start: EmulatorScreenPoint; end: EmulatorScreenPoint } | null {
  if (Math.hypot(delta.x, delta.y) < 1e-9) {
    return null
  }
  // iOS reserves screen edges for system gestures in every orientation.
  const start = {
    x: Math.max(0.12, Math.min(0.88, point.x)),
    y: Math.max(0.12, Math.min(0.88, point.y))
  }
  for (const axis of ['x', 'y'] as const) {
    if (start[axis] <= 0.12 && delta[axis] < 0) {
      start[axis] = 0.88
    } else if (start[axis] >= 0.88 && delta[axis] > 0) {
      start[axis] = 0.12
    }
  }
  const xFraction = delta.x === 0 ? Infinity : ((delta.x < 0 ? 0.12 : 0.88) - start.x) / delta.x
  const yFraction = delta.y === 0 ? Infinity : ((delta.y < 0 ? 0.12 : 0.88) - start.y) / delta.y
  const fraction = Math.min(1, xFraction, yFraction)
  return {
    start,
    end: {
      x: fraction === xFraction ? (delta.x < 0 ? 0.12 : 0.88) : start.x + delta.x * fraction,
      y: fraction === yFraction ? (delta.y < 0 ? 0.12 : 0.88) : start.y + delta.y * fraction
    }
  }
}
