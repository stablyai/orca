/**
 * Which way a dragged pet is facing, and how much horizontal travel it takes to
 * change its mind.
 *
 * Shared rather than per-surface for the same reason edge geometry is (see
 * pet-presence's EDGE_ENTRY_INSET): the phone and the desktop are two views of
 * one creature, and a pet that flips direction after 4px on one screen and 12px
 * on the other is two different pets. When this lived only in the renderer, the
 * phone had no way to reuse it without copying the threshold — and a copied
 * threshold is a threshold that drifts.
 *
 * Pure: no DOM, no React Native. Pointer events on the desktop and PanResponder
 * on the phone both reduce to "how far sideways since the last accepted turn".
 */

export type PetDragAnimation = 'running-right' | 'running-left' | null

/**
 * Hysteresis for drag direction.
 *
 * `accepted` means "advance the baseline". It fires only past the threshold, so
 * a slow diagonal drag keeps accumulating toward a turn instead of resetting
 * its baseline every frame and never committing to one.
 */
export const PET_DRAG_DIRECTION_THRESHOLD_PX = 4

export function nextPetDragAnimation(
  current: PetDragAnimation,
  deltaX: number
): { animation: PetDragAnimation; accepted: boolean } {
  if (deltaX >= PET_DRAG_DIRECTION_THRESHOLD_PX) {
    return { animation: 'running-right', accepted: true }
  }
  if (deltaX <= -PET_DRAG_DIRECTION_THRESHOLD_PX) {
    return { animation: 'running-left', accepted: true }
  }
  return { animation: current, accepted: false }
}

/** Facing implied by a drag direction, keeping the previous facing while the
 *  drag has not yet committed to one. The phone has no named run animations —
 *  its sprite only faces left or right — so this is the mobile projection of
 *  the same rule. */
export function facingForDragAnimation(
  animation: PetDragAnimation,
  previous: 'left' | 'right'
): 'left' | 'right' {
  if (animation === 'running-right') {
    return 'right'
  }
  if (animation === 'running-left') {
    return 'left'
  }
  return previous
}
