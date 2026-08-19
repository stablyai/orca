import type { CSSProperties } from 'react'

const BOB_KEYFRAMES =
  '@keyframes pet-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'

// Why: a pendulum swing with squash at the arc's ends (velocity 0, body settles)
// and stretch through the bottom (max speed) — reads as dangling from a hand.
const HELD_SWAY_KEYFRAMES =
  '@keyframes pet-held-sway {' +
  ' 0%,100% { transform: rotate(-8deg) scale(1.02, 0.97); }' +
  ' 25% { transform: rotate(0deg) scale(0.98, 1.04); }' +
  ' 50% { transform: rotate(8deg) scale(1.02, 0.97); }' +
  ' 75% { transform: rotate(0deg) scale(0.98, 1.04); } }'

// Why: Shimeji's `Bouncing` is two poses of four ticks — the impact reads as a
// blink, not a wobble. Compress, overshoot slightly, settle.
const LAND_SQUASH_KEYFRAMES =
  '@keyframes pet-land-squash {' +
  ' 0% { transform: scale(1, 1); }' +
  ' 35% { transform: scale(1.14, 0.84); }' +
  ' 70% { transform: scale(0.96, 1.05); }' +
  ' 100% { transform: scale(1, 1); } }'

/** Runtime CSS, deliberately outside i18n so a translated locale can't invalidate it. */
export const PET_BODY_MOTION_KEYFRAMES_CSS = `${BOB_KEYFRAMES}\n${HELD_SWAY_KEYFRAMES}\n${LAND_SQUASH_KEYFRAMES}`

export type PetBodyMotion = {
  held: boolean
  landing: boolean
  motionAllowed: boolean
  landingDurationMs: number
}

/** Idle bob, the hanging sway while in hand, or the one-shot landing squash. */
export function petBodyMotionStyle({
  held,
  landing,
  motionAllowed,
  landingDurationMs
}: PetBodyMotion): CSSProperties {
  if (landing && !held) {
    return {
      animation: `pet-land-squash ${landingDurationMs}ms ease-out 1`,
      // Why: squashing onto the floor, so the feet stay planted and the body
      // compresses downward rather than shrinking about its middle.
      transformOrigin: '50% 100%',
      animationPlayState: motionAllowed ? 'running' : 'paused'
    }
  }
  return {
    animation: held
      ? 'pet-held-sway 0.9s ease-in-out infinite'
      : 'pet-bob 1.2s ease-in-out infinite',
    // Why: the sway pivots at the top edge so the body hangs below the grab
    // point instead of spinning about its own centre.
    transformOrigin: held ? '50% 0%' : undefined,
    animationPlayState: motionAllowed ? 'running' : 'paused'
  }
}
