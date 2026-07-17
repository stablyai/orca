import type { CustomPet, SpriteAnimation } from './types'

/** Codex pet sprite layout and pacing, mirroring the tables in Codex CLI's
 *  `tui/src/pets`. Shared because main bakes these into imported bundles and
 *  the renderer needs the same fingerprint to upgrade legacy persisted pets. */

export const CODEX_PET_SPRITESHEET_PATH = 'spritesheet.webp'
export const CODEX_PET_FRAME = { width: 192, height: 208 } as const
export const CODEX_PET_DEFAULT_ANIMATION = 'idle'
export const CODEX_PET_DEFAULT_FPS = 8
// Codex sheets are 8 columns wide (its widest rows run 8 frames).
export const CODEX_PET_DEFAULT_COLUMNS = 8

// Codex's `app_state_animation`: every non-final frame holds `frameMs`, the last
// holds `finalMs`. Values below mirror `codex-rs/tui/src/pets/model.rs` exactly.
function appStateDurations(frames: number, frameMs: number, finalMs: number): number[] {
  return Array.from({ length: frames }, (_, i) => (i === frames - 1 ? finalMs : frameMs))
}

export const CODEX_PET_ANIMATIONS: Record<string, SpriteAnimation> = {
  // Idle is the ambient loop: long holds on the bookend frames, 6.6s cycle.
  idle: { row: 0, frames: 6, frameDurationsMs: [1680, 660, 660, 840, 840, 1920] },
  'running-right': { row: 1, frames: 8, frameDurationsMs: appStateDurations(8, 120, 220) },
  'running-left': { row: 2, frames: 8, frameDurationsMs: appStateDurations(8, 120, 220) },
  waving: { row: 3, frames: 4, frameDurationsMs: appStateDurations(4, 140, 280) },
  jumping: { row: 4, frames: 5, frameDurationsMs: appStateDurations(5, 140, 280) },
  failed: { row: 5, frames: 8, frameDurationsMs: appStateDurations(8, 140, 240) },
  waiting: { row: 6, frames: 6, frameDurationsMs: appStateDurations(6, 150, 260) },
  running: { row: 7, frames: 6, frameDurationsMs: appStateDurations(6, 120, 220) },
  review: { row: 8, frames: 6, frameDurationsMs: appStateDurations(6, 150, 280) }
}

/** The Codex row layout paced uniformly at `fps` (each frame held 1000/fps ms).
 *  A bundle that pins an explicit fps gets its pacing baked as durations, so the
 *  fps is honored (SpriteFrame prefers durations over the sheet fps) and the
 *  sprite carries durations — which keeps it distinct from the no-durations
 *  legacy fingerprint below, so the render-time upgrade never retimes it. */
export function codexAnimationsAtUniformFps(fps: number): Record<string, SpriteAnimation> {
  const frameMs = 1000 / fps
  return Object.fromEntries(
    Object.entries(CODEX_PET_ANIMATIONS).map(([name, { row, frames }]) => [
      name,
      { row, frames, frameDurationsMs: Array.from({ length: frames }, () => frameMs) }
    ])
  )
}

export type CustomPetSprite = NonNullable<CustomPet['sprite']>

/** The exact sprite an old Orca build baked for an imported Codex bundle:
 *  192x208 frames on an 8-wide sheet at the flat 8 fps rate, idle default, and
 *  the nine Codex rows carrying no per-frame durations. Matching the full
 *  geometry (not just the row map) keeps a hand-authored 8 fps sheet that merely
 *  reuses those rows from being silently retimed. A pet deliberately built on
 *  the Codex layout that wants to keep uniform pacing opts out by declaring any
 *  frameDurationsMs of its own.
 *
 *  Rows/sheet height are intentionally excluded so v2 (11-row) Codex sheets,
 *  which still bake these nine animations, upgrade too. */
function isLegacyCodexSprite(sprite: CustomPetSprite): boolean {
  const animations = sprite.animations
  if (
    !animations ||
    sprite.fps !== CODEX_PET_DEFAULT_FPS ||
    sprite.frameWidth !== CODEX_PET_FRAME.width ||
    sprite.frameHeight !== CODEX_PET_FRAME.height ||
    sprite.columns !== CODEX_PET_DEFAULT_COLUMNS ||
    sprite.defaultAnimation !== CODEX_PET_DEFAULT_ANIMATION
  ) {
    return false
  }
  const names = Object.keys(animations)
  if (names.length !== Object.keys(CODEX_PET_ANIMATIONS).length) {
    return false
  }
  return names.every((name) => {
    const anim = animations[name]
    const preset = CODEX_PET_ANIMATIONS[name]
    // Why: `anim` is untrusted persisted data — guard it so a corrupted entry
    // (e.g. a null value) is a non-match rather than a render-time throw.
    return (
      !!preset &&
      !!anim &&
      anim.row === preset.row &&
      anim.frames === preset.frames &&
      anim.frameDurationsMs === undefined
    )
  })
}

/** Pets imported before per-frame durations existed persist the legacy Codex
 *  fingerprint at the flat 8 fps sheet rate, so swap in the current defaults for
 *  those. Anything else passes through untouched. Render-time only — persisted
 *  data is never rewritten, so the upgrade is reversible on downgrade. */
export function applyCodexSpriteTimingDefaults(sprite: CustomPetSprite): CustomPetSprite {
  if (!isLegacyCodexSprite(sprite)) {
    return sprite
  }
  return { ...sprite, animations: { ...CODEX_PET_ANIMATIONS } }
}
