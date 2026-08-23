import type { PetAnimationName } from './pet-agent-state'

export type PetPose = { animation: PetAnimationName; pacing: boolean }

/** States that are poses rather than travel: reaching one parks the pet. */
const HALTING: ReadonlySet<PetAnimationName> = new Set(['waiting', 'jumping', 'review'])

/** Reconciles the agent-state animation with lane pacing.
 *
 *  Pacing wins the ambient states — walking with an idle/breathing row playing
 *  reads as gliding — while pose states (waiting, hover-jump, review) win the
 *  pacing, parking the pet until the state passes. Drag rows pass through: the
 *  drag already owns both the position and the row. */
export type PetFallPose = 'falling' | 'downed' | 'rising'

export function arbitratePetPose(
  animation: PetAnimationName,
  wantsPacing: boolean,
  fall: PetFallPose | null
): PetPose {
  // Why: mid-air is mid-air. No agent state should stand the pet back up, so the
  // fall phase is checked before anything else.
  if (fall) {
    return { animation: fall, pacing: false }
  }
  if (animation === 'running-right' || animation === 'running-left') {
    return { animation, pacing: false }
  }
  if (HALTING.has(animation)) {
    return { animation, pacing: false }
  }
  if (wantsPacing) {
    return { animation: 'running', pacing: true }
  }
  return { animation, pacing: false }
}
