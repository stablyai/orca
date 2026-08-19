import type { CustomPet } from '../../../../shared/pet-types'
import type { PetAnimationName } from './pet-agent-state'

/** A bundled pet's pose sheet: equal cells, one animation per row. */
export type BundledPetPoses = {
  url: string
  frameWidth: number
  frameHeight: number
  /** Columns; every row uses the full width. */
  frames: number
  fps: number
}

/** Physical rows in the generated sheet. */
const ROW = { idle: 0, running: 1, waiting: 2, jumping: 3 } as const

/** Per-row frame hold. Breathing at running speed reads as panic, and the hop
 *  needs to snap, so the sheet fps alone is not enough. */
const HOLD_MS = { idle: 420, running: 125, waiting: 220, jumping: 110 } as const

/** Every live state is mapped, so `SpriteFrame` never falls back: an unmapped
 *  name would silently play the default row and look like a stuck animation.
 *  The drag rows share the locomotion row, and `review` borrows the waiting
 *  pose — the pet is idling on a result either way. */
const POSE: Record<PetAnimationName, keyof typeof ROW> = {
  idle: 'idle',
  running: 'running',
  'running-left': 'running',
  'running-right': 'running',
  waiting: 'waiting',
  review: 'waiting',
  jumping: 'jumping'
}

export function poseSpriteFrom(poses: BundledPetPoses): NonNullable<CustomPet['sprite']> {
  const rows = Object.keys(ROW).length
  const animations = Object.fromEntries(
    Object.entries(POSE).map(([name, row]) => [
      name,
      {
        row: ROW[row],
        frames: poses.frames,
        frameDurationsMs: Array.from({ length: poses.frames }, () => HOLD_MS[row])
      }
    ])
  )
  return {
    frameWidth: poses.frameWidth,
    frameHeight: poses.frameHeight,
    columns: poses.frames,
    rows,
    sheetWidth: poses.frameWidth * poses.frames,
    sheetHeight: poses.frameHeight * rows,
    fps: poses.fps,
    defaultAnimation: 'idle',
    animations
  }
}
