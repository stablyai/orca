// Mirror the importer’s frame-duration cap to prevent corrupted holds from freezing playback.
const MAX_FRAME_DURATION_MS = 60_000

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
  rowOffsetY: number
  // Per-frame holds in ms; uneven pacing renders when they pass validation.
  frameDurationsMs: number[] | undefined
}

// Keep runtime CSS keywords outside translation so locales cannot invalidate animation.
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
    // Uneven holds require one step-end stop per frame; steps() supports only uniform pacing.
    const stops = stepEndStops(durations, totalMs, frameWidth, scale, rowOffsetY)
    if (stops) {
      return {
        keyframesCss: `@keyframes ${name} { ${stops.join(' ')} }`,
        animationCss: `${name} ${totalMs / 1000}s step-end infinite`
      }
    }
  }
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
  // Validate untrusted persisted/RPC arrays and duration bounds; fall back to uniform pacing instead of throwing/freezing.
  if (
    Array.isArray(frameDurationsMs) &&
    frameDurationsMs.length === frames &&
    frameDurationsMs.every((ms) => Number.isFinite(ms) && ms > 0 && ms <= MAX_FRAME_DURATION_MS)
  ) {
    return frameDurationsMs
  }
  return null
}

// Return null when 4-decimal stops collapse or reach 100% early so uniform fallback keeps every frame visible.
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
    if (pct <= previousPct || pct >= 100) {
      return null
    }
    previousPct = pct
    const x = -(index * frameWidth * scale)
    stops.push(`${pct}% { background-position: ${x}px ${rowOffsetY}px; }`)
    elapsedMs += durations[index]
  }
  return stops
}
