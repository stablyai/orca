// The captured window is drawn with object-fit: contain, so a point maps through the letterboxed
// content rect, then from video pixels to window points (Retina capture is 2x the window size).
import { mapClientPointToSimulatorScreen } from '../emulator-pane/emulator-screen-gesture'

type Size = { width: number; height: number }
export type Point = { x: number; y: number }

function boxRect(box: Size) {
  return { left: 0, top: 0, width: box.width, height: box.height }
}

function hasArea(size: Size): boolean {
  return size.width > 0 && size.height > 0
}

/** A point relative to the video element's box → window points; null outside the picture. */
export function mapElementPointToWindowPoint(
  point: Point,
  box: Size,
  media: Size,
  windowSize: Size
): Point | null {
  if (!hasArea(media)) {
    return null
  }
  const normalized = mapClientPointToSimulatorScreen(
    { clientX: point.x, clientY: point.y },
    boxRect(box),
    media
  )
  return normalized
    ? { x: round1(normalized.x * windowSize.width), y: round1(normalized.y * windowSize.height) }
    : null
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
