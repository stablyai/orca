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

/** Runtime CSS, deliberately outside i18n so a translated locale can't invalidate it. */
export const PET_BODY_MOTION_KEYFRAMES_CSS = `${BOB_KEYFRAMES}\n${HELD_SWAY_KEYFRAMES}`

/** Idle bob, or the hanging sway once the pet is in hand. */
export function petBodyMotionStyle(held: boolean, motionAllowed: boolean): CSSProperties {
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
