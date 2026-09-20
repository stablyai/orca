// Why: a drag that reaches the edge of the pane has to pull the viewport with it, or a range can
// never be longer than one screen. Pure, so the speed curve is testable without a laid-out editor.

// Distance from an edge at which a held drag starts pulling, and the px-per-60Hz-frame floor and
// ceiling of that pull.
const AUTO_SCROLL_EDGE_PX = 24
const AUTO_SCROLL_MIN_PX = 4
const AUTO_SCROLL_MAX_PX = 32
const AUTO_SCROLL_ACCELERATION = 0.6
const REFERENCE_FRAME_MS = 1000 / 60
// A backgrounded window resumes with a huge timestamp delta; cap it so the viewport can't jump.
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
  // Scaled by the real frame delta, so a 120Hz display scrolls at the same speed as a 60Hz one.
  return (
    Math.sign(overshoot) * speed * (Math.min(MAX_FRAME_DELTA_MS, frameDeltaMs) / REFERENCE_FRAME_MS)
  )
}

export { REFERENCE_FRAME_MS }
