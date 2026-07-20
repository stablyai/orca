// Sprite-sheet keyframe CSS for the pet overlay. Kept as a pure module so the
// pacing math is unit-testable without mounting the overlay or a DOM.

// Mirror of the importer's per-frame cap (pet.ts zod schema): a hold longer than
// this at render would freeze the overlay, so reject it on the render side too.
const MAX_FRAME_DURATION_MS = 60_000

export type SpriteAnimationCss = {
  keyframesCss: string
  animationCss: string
}

// Why: repeat x frames becomes one stop each, so bound the emitted keyframe set
// the same way the importer bounds frames.
const MAX_REPEATED_STOPS = 512

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
  // How many times the row plays before `settle` takes over.
  repeat?: number
  // Resolved track that becomes the steady loop; absent means the row loops.
  settle?: {
    frames: number
    rowOffsetY: number
    frameDurationsMs: number[] | undefined
  }
  // Ms already spent in this state when the track is minted. Fast-forwards the
  // played part of the burst so a re-minted track resumes instead of replaying.
  settleElapsedMs?: number
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
  frameDurationsMs,
  repeat,
  settle,
  settleElapsedMs
}: SpriteAnimationCssInput): SpriteAnimationCss {
  const name = `pet-${keyframesId}`
  const durations = validFrameDurations(frameDurationsMs, frames)
  if (durations) {
    const settled = buildSettlingCss({
      name,
      durations,
      frames,
      frameWidth,
      scale,
      rowOffsetY,
      repeat,
      settle,
      settleElapsedMs
    })
    if (settled) {
      return settled
    }
    // Why: Codex pets hold frames unevenly (idle rests ~1.9s on its last frame).
    // steps() can't express that, so emit one step-end stop per frame.
    const track = buildTrack(name, durations, frames, frameWidth, scale, rowOffsetY)
    if (track) {
      return {
        keyframesCss: track.keyframesCss,
        animationCss: `${name} ${track.totalMs / 1000}s step-end infinite`
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
  // Why: Array.isArray + bounds, not a truthiness check — persisted/RPC-synced
  // sprites are untrusted, so a corrupt non-array or out-of-range hold falls back
  // to uniform pacing instead of throwing or freezing the overlay.
  if (
    Array.isArray(frameDurationsMs) &&
    frameDurationsMs.length === frames &&
    frameDurationsMs.every((ms) => Number.isFinite(ms) && ms > 0 && ms <= MAX_FRAME_DURATION_MS)
  ) {
    return frameDurationsMs
  }
  return null
}

// Why: Codex's app-state rows play a few times and then rest on idle forever
// (`app_state_animation` sets loop_start past the repeats). CSS can't loop part
// of one timeline, so emit the repeats and the resting track as two animations
// and start the resting one on a delay equal to the repeats.
function buildSettlingCss({
  name,
  durations,
  frames,
  frameWidth,
  scale,
  rowOffsetY,
  repeat,
  settle,
  settleElapsedMs
}: {
  name: string
  durations: number[]
  frames: number
  frameWidth: number
  scale: number
  rowOffsetY: number
  repeat: number | undefined
  settle: SpriteAnimationCssInput['settle']
  settleElapsedMs: number | undefined
}): SpriteAnimationCss | null {
  if (
    !settle ||
    !Number.isInteger(repeat) ||
    repeat === undefined ||
    repeat < 1 ||
    repeat * frames > MAX_REPEATED_STOPS
  ) {
    return null
  }
  const settleDurations = validFrameDurations(settle.frameDurationsMs, settle.frames)
  if (!settleDurations) {
    return null
  }
  const burstDurations = Array.from({ length: repeat }, () => durations).flat()
  const burst = buildTrack(`${name}-burst`, burstDurations, frames, frameWidth, scale, rowOffsetY)
  const rest = buildTrack(
    `${name}-rest`,
    settleDurations,
    settle.frames,
    frameWidth,
    scale,
    settle.rowOffsetY
  )
  if (!burst || !rest) {
    return null
  }
  // Why: aligned with Codex's player, which measures elapsed from when the
  // state started. Negative delays fast-forward a re-minted track by the time
  // already played, so ending a drag or hover resumes rather than replays.
  const elapsedMs = Math.max(0, settleElapsedMs ?? 0)
  const burstDelayS = -Math.round(Math.min(elapsedMs, burst.totalMs)) / 1000
  const restDelayS = Math.round(burst.totalMs - elapsedMs) / 1000
  return {
    keyframesCss: `${burst.keyframesCss} ${rest.keyframesCss}`,
    animationCss:
      `${name}-burst ${burst.totalMs / 1000}s step-end ${burstDelayS}s 1, ` +
      `${name}-rest ${rest.totalMs / 1000}s step-end ${restDelayS}s infinite`
  }
}

function buildTrack(
  name: string,
  durations: number[],
  columns: number,
  frameWidth: number,
  scale: number,
  rowOffsetY: number
): { keyframesCss: string; totalMs: number } | null {
  const totalMs = durations.reduce((sum, ms) => sum + ms, 0)
  const stops = stepEndStops(durations, totalMs, columns, frameWidth, scale, rowOffsetY)
  if (!stops) {
    return null
  }
  return { keyframesCss: `@keyframes ${name} { ${stops.join(' ')} }`, totalMs }
}

// Cumulative step-end stops, one per frame. `columns` wraps the x offset so a
// repeated row replays its own cells. Returns null (→ uniform fallback) when a
// frame is too short to survive 4-decimal precision (two stops collapse, or the
// final stop rounds to 100%) so no frame is silently dropped.
function stepEndStops(
  durations: number[],
  totalMs: number,
  columns: number,
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
    const x = -((index % columns) * frameWidth * scale)
    stops.push(`${pct}% { background-position: ${x}px ${rowOffsetY}px; }`)
    elapsedMs += durations[index]
  }
  return stops
}
