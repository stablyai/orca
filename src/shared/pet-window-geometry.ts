import { PET_SIZE_MAX, type PetWindowPosition } from './pet-types'

/** Slack around the pet inside its detached window: the bob float lifts 4px and sprite
 *  footprints round up, so a window sized exactly to petSize clips the top of the arc. */
export const PET_WINDOW_MARGIN = 16

export function petWindowSizeForPetSize(petSize: number): number {
  return Math.round(Math.min(petSize, PET_SIZE_MAX)) + PET_WINDOW_MARGIN * 2
}

export type PetWindowWorkArea = { x: number; y: number; width: number; height: number }

/** Where a freshly detached pet lands: bottom-right of the work area, mirroring the in-window
 *  overlay's default corner. */
export function defaultPetWindowPosition(
  workArea: PetWindowWorkArea,
  windowSize: number
): PetWindowPosition {
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - windowSize - 48)),
    y: Math.round(workArea.y + Math.max(0, workArea.height - windowSize - 24))
  }
}
