import type { CustomPet, SpriteAnimation } from './pet-types'

/** Mirror Codex CLI tui/src/pets so main import defaults and renderer legacy-upgrade fingerprints agree. */

export const CODEX_PET_SPRITESHEET_PATH = 'spritesheet.webp'
export const CODEX_PET_FRAME = { width: 192, height: 208 } as const
export const CODEX_PET_DEFAULT_ANIMATION = 'idle'
export const CODEX_PET_DEFAULT_FPS = 8
// Codex sheets are 8 columns wide (its widest rows run 8 frames).
export const CODEX_PET_DEFAULT_COLUMNS = 8

// Mirror codex-rs/tui/src/pets/model.rs: final frames hold finalMs, others frameMs.
function appStateDurations(frames: number, frameMs: number, finalMs: number): number[] {
  return Array.from({ length: frames }, (_, i) => (i === frames - 1 ? finalMs : frameMs))
}

export const CODEX_PET_ANIMATIONS: Record<string, SpriteAnimation> = {
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

/** Bake explicit fps as durations (preferred by SpriteFrame), honoring uniform timing while distinguishing these bundles from legacy no-duration fingerprints. */
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

/** Match the complete legacy 192x208, 8-wide, flat-8fps, idle-default nine-animation fingerprint without durations; avoid retiming hand-authored lookalikes. Own durations opt out. Ignore row count/sheet height so 11-row v2 sheets still upgrade. */
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
    // Guard untrusted animation entries so corrupt persisted data cannot throw during render.
    return (
      !!preset &&
      !!anim &&
      anim.row === preset.row &&
      anim.frames === preset.frames &&
      anim.frameDurationsMs === undefined
    )
  })
}

/** Upgrade legacy flat-8fps imports at render time only; never rewrite persisted data, preserving downgrade reversibility. */
export function applyCodexSpriteTimingDefaults(sprite: CustomPetSprite): CustomPetSprite {
  if (!isLegacyCodexSprite(sprite)) {
    return sprite
  }
  return { ...sprite, animations: { ...CODEX_PET_ANIMATIONS } }
}
