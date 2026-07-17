// Sprite-sheet keyframe CSS for the pet overlay. Kept as a pure module so the
// pacing math is unit-testable without mounting the overlay or a DOM.

export type SpriteAnimationCss = {
  keyframesCss: string
  animationCss: string
}

export type SpriteAnimationCssInput = {
  // Sanitized `@keyframes` identifier; folded with the restart key by the caller.
  keyframesId: string
  frames: number
  fps: number
  frameWidth: number
  scale: number
  // Vertical offset selecting the animation's row on the sheet.
  rowOffsetY: number
  // Per-frame holds in ms; uneven pacing renders when they pass validation.
  frameDurationsMs: number[] | undefined
}

// Why: sprite keyframes are runtime CSS, not user-visible copy; translated CSS
// keywords make the browser discard the animation, so keep them out of i18n.
export function buildSpriteAnimationCss({
  keyframesId,
  frames,
  fps,
  frameWidth,
  scale,
  rowOffsetY,
  frameDurationsMs
}: SpriteAnimationCssInput): SpriteAnimationCss {
  const name = `pet-${keyframesId}`
  const durations = validFrameDurations(frameDurationsMs, frames)
  if (durations) {
    const totalMs = durations.reduce((sum, ms) => sum + ms, 0)
    // Why: Codex pets hold frames unevenly (idle rests ~1.9s on its last frame).
    // steps() can't express that, so emit one step-end stop per frame.
    const stops = stepEndStops(durations, totalMs, frameWidth, scale, rowOffsetY)
    if (stops) {
      return {
        keyframesCss: `@keyframes ${name} { ${stops.join(' ')} }`,
        animationCss: `${name} ${totalMs / 1000}s step-end infinite`
      }
    }
  }
  // Uniform sheet fps: one steps() run across the row.
  const duration = Math.max(0.1, frames / Math.max(0.1, fps))
  const endX = -(frames * frameWidth * scale)
  return {
    keyframesCss: `@keyframes ${name} { from { background-position: 0px ${rowOffsetY}px; } to { background-position: ${endX}px ${rowOffsetY}px; } }`,
    animationCss: `${name} ${duration}s steps(${frames}) infinite`
  }
}

function validFrameDurations(
  frameDurationsMs: number[] | undefined,
  frames: number
): number[] | null {
  if (
    frameDurationsMs &&
    frameDurationsMs.length === frames &&
    frameDurationsMs.every((ms) => Number.isFinite(ms) && ms > 0)
  ) {
    return frameDurationsMs
  }
  return null
}

// Cumulative step-end stops, one per frame. Returns null when two stops collapse
// to the same serialized percentage (a frame shorter than our 4-decimal
// precision can resolve) so the caller degrades to uniform pacing rather than
// silently dropping the frame the later duplicate selector would win.
function stepEndStops(
  durations: number[],
  totalMs: number,
  frameWidth: number,
  scale: number,
  rowOffsetY: number
): string[] | null {
  const stops: string[] = []
  let elapsedMs = 0
  let previousPct = -1
  for (let index = 0; index < durations.length; index++) {
    const pct = +((elapsedMs / totalMs) * 100).toFixed(4)
    if (pct <= previousPct) {
      return null
    }
    previousPct = pct
    const x = -(index * frameWidth * scale)
    stops.push(`${pct}% { background-position: ${x}px ${rowOffsetY}px; }`)
    elapsedMs += durations[index]
  }
  return stops
}
