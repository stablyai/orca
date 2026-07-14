import type { CustomPet, SpriteAnimation } from './types'

/** Codex pet sprite layout and pacing, mirroring the tables in Codex CLI's
 *  `tui/src/pets`. Shared because main bakes these into imported bundles and
 *  the renderer needs the same fingerprint to upgrade legacy persisted pets. */

export const CODEX_PET_SPRITESHEET_PATH = 'spritesheet.webp'
export const CODEX_PET_FRAME = { width: 192, height: 208 } as const
export const CODEX_PET_DEFAULT_ANIMATION = 'idle'
export const CODEX_PET_DEFAULT_FPS = 8

// App-state rows run ~7-8 fps with a longer hold on the final frame.
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

export type CustomPetSprite = NonNullable<CustomPet['sprite']>

/** Pets imported before per-frame durations existed persist the exact default
 *  fingerprint at the flat 8 fps sheet rate, so swap in the current defaults
 *  for those. Anything hand-authored passes through untouched. */
export function applyCodexSpriteTimingDefaults(sprite: CustomPetSprite): CustomPetSprite {
  const animations = sprite.animations
  if (!animations || sprite.fps !== CODEX_PET_DEFAULT_FPS) {
    return sprite
  }
  const names = Object.keys(animations)
  if (names.length !== Object.keys(CODEX_PET_ANIMATIONS).length) {
    return sprite
  }
  for (const name of names) {
    const anim = animations[name]
    const preset = CODEX_PET_ANIMATIONS[name]
    if (
      !preset ||
      anim.row !== preset.row ||
      anim.frames !== preset.frames ||
      anim.frameDurationsMs !== undefined
    ) {
      return sprite
    }
  }
  return { ...sprite, animations: { ...CODEX_PET_ANIMATIONS } }
}
