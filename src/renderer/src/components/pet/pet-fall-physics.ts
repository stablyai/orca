/** Shimeji's fall model (gravity + air resistance → terminal velocity), retuned
 *  for a 60fps app window: a pure-gravity drop reads as a stone, not a pet.
 *  See conf/actions.xml `Falling` (Gravity=2, RegistanceX=.05, RegistanceY=.1). */
export const PET_FALL = {
  gravityPxPerSec2: 2600,
  terminalVyPxPerSec: 1200,
  /** Horizontal momentum from a throw bleeds off; fraction retained per second. */
  horizontalDragPerSec: 1.8
} as const

export type PetFallState = { x: number; y: number; vx: number; vy: number }

export type PetFallStep = {
  deltaMs: number
  gravityPxPerSec2: number
  terminalVyPxPerSec: number
  horizontalDragPerSec: number
  laneY: number
  minX: number
  maxX: number
}

export type PetFallResult = PetFallState & { landed: boolean }

export function advancePetFall(state: PetFallState, step: PetFallStep): PetFallResult {
  const dt = step.deltaMs / 1000
  const vy = Math.min(state.vy + step.gravityPxPerSec2 * dt, step.terminalVyPxPerSec)
  const vx = state.vx * Math.max(0, 1 - step.horizontalDragPerSec * dt)
  const y = state.y + vy * dt
  let x = state.x + vx * dt

  // Why: a thrown pet must not leave the lane's travel range — stop dead at the
  // wall rather than sliding off-screen where it can't be grabbed back.
  let wallVx = vx
  if (x <= step.minX) {
    x = step.minX
    wallVx = 0
  } else if (x >= step.maxX) {
    x = step.maxX
    wallVx = 0
  }

  if (y >= step.laneY) {
    return { x, y: step.laneY, vx: 0, vy: 0, landed: true }
  }
  return { x, y, vx: wallVx, vy, landed: false }
}
