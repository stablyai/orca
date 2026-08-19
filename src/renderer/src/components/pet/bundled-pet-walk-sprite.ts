import type { CustomPet } from '../../../../shared/pet-types'

/** A bundled pet's walk cycle: one horizontal strip of equal-width frames. */
export type BundledPetWalk = {
  url: string
  frameWidth: number
  frameHeight: number
  frames: number
  fps: number
}

/** Reuses the sprite-sheet renderer built for `.codex-pet` bundles instead of
 *  adding a second animation path — the strip is just a one-row sheet. */
export function walkSpriteFrom(walk: BundledPetWalk): NonNullable<CustomPet['sprite']> {
  return {
    frameWidth: walk.frameWidth,
    frameHeight: walk.frameHeight,
    columns: walk.frames,
    rows: 1,
    sheetWidth: walk.frameWidth * walk.frames,
    sheetHeight: walk.frameHeight,
    fps: walk.fps,
    defaultAnimation: 'walk',
    animations: { walk: { row: 0, frames: walk.frames } }
  }
}
