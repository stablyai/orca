// Edge scrolling lets review ranges extend beyond one viewport.

const AUTO_SCROLL_EDGE_PX = 24
const AUTO_SCROLL_MIN_PX = 4
const AUTO_SCROLL_MAX_PX = 32
const AUTO_SCROLL_ACCELERATION = 0.6
const REFERENCE_FRAME_MS = 1000 / 60
// Cap the large timestamp delta after backgrounding to prevent viewport jumps.
const MAX_FRAME_DELTA_MS = 50

export function getDragAutoScrollStepPx({
  editorTop,
  editorBottom,
  clientY,
  frameDeltaMs
}: {
  editorTop: number
  editorBottom: number
  clientY: number
  frameDeltaMs: number
}): number {
  const topEdge = editorTop + AUTO_SCROLL_EDGE_PX
  const bottomEdge = editorBottom - AUTO_SCROLL_EDGE_PX
  const overshoot =
    clientY < topEdge ? clientY - topEdge : clientY > bottomEdge ? clientY - bottomEdge : 0
  if (overshoot === 0) {
    return 0
  }
  const speed = Math.min(
    AUTO_SCROLL_MAX_PX,
    AUTO_SCROLL_MIN_PX + Math.abs(overshoot) * AUTO_SCROLL_ACCELERATION
  )
  // Normalize scrolling speed across display refresh rates.
  return (
    Math.sign(overshoot) * speed * (Math.min(MAX_FRAME_DELTA_MS, frameDeltaMs) / REFERENCE_FRAME_MS)
  )
}

export { REFERENCE_FRAME_MS }
