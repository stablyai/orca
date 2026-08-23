/** Calm pacing speed — fast enough to read as walking, slow enough to ignore. */
export const PET_WALK_SPEED_PX_PER_SEC = 36

export type PetWalkDirection = 'left' | 'right'

export type PetWalkState = { x: number; direction: PetWalkDirection }

export type PetWalkStep = {
  deltaMs: number
  speedPxPerSec: number
  minX: number
  maxX: number
}

/** Horizontal travel available to the pet box, in overlay (left) coordinates. */
export function petWalkBounds(viewportWidth: number, size: number): { minX: number; maxX: number } {
  return { minX: 0, maxX: Math.max(0, viewportWidth - size) }
}

/** Top offset that rests the pet box on the bottom inset (status bar + gap). */
export function petLaneY(viewportHeight: number, size: number, bottomInset: number): number {
  return Math.max(0, viewportHeight - size - bottomInset)
}

export function advancePetWalk(state: PetWalkState, step: PetWalkStep): PetWalkState {
  // Why: a viewport narrower than the pet collapses the lane — bouncing between
  // coincident edges would flip direction every frame and read as a seizure.
  if (step.maxX <= step.minX) {
    return { x: step.minX, direction: state.direction }
  }
  const travel = (step.speedPxPerSec * step.deltaMs) / 1000
  const x = state.direction === 'right' ? state.x + travel : state.x - travel
  if (x >= step.maxX) {
    return { x: step.maxX, direction: 'left' }
  }
  if (x <= step.minX) {
    return { x: step.minX, direction: 'right' }
  }
  return { x, direction: state.direction }
}
