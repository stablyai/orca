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
  /** True when the artwork already bounces (a walk strip), so the bob is skipped. */
  selfAnimated: boolean
  /** Toppled onto its back — airborne after a real drop, or lying on the lane. */
  supine: boolean
  /** Getting back on its feet after being down. */
  rising: boolean
  /** Half the rendered artwork width; see the lift in `petBodyMotionStyle`. */
  supineLiftPx: number
  risingDurationMs: number
}

const SUPINE_TIP_MS = 320

/** Idle bob, the hanging sway while in hand, or the one-shot landing squash. */
export function petBodyMotionStyle({
  held,
  landing,
  motionAllowed,
  landingDurationMs,
  selfAnimated,
  supine,
  rising,
  supineLiftPx,
  risingDurationMs
}: PetBodyMotion): CSSProperties {
  if ((supine || rising) && !held) {
    // Why: pivot on the feet so the pet topples backwards rather than spinning
    // about its middle. A 90-degree turn about that point leaves half the body
    // below the lane, so lift by half the artwork's width to lay it on the floor.
    return {
      animation: 'none',
      transformOrigin: '50% 100%',
      transform: rising ? 'none' : `translateY(-${supineLiftPx}px) rotate(-90deg)`,
      transition: `transform ${rising ? risingDurationMs : SUPINE_TIP_MS}ms ${
        rising ? 'cubic-bezier(0.22, 0.9, 0.3, 1)' : 'ease-in'
      }`
    }
  }
  if (landing && !held) {
    return {
      animation: `pet-land-squash ${landingDurationMs}ms ease-out 1`,
      // Why: squashing onto the floor, so the feet stay planted and the body
      // compresses downward rather than shrinking about its middle.
      transformOrigin: '50% 100%',
      animationPlayState: motionAllowed ? 'running' : 'paused'
    }
  }
  // Why: stacking the bob on a walk cycle that already lifts the body gives two
  // vertical oscillations at different periods — it reads as a wobble, not a walk.
  if (selfAnimated && !held) {
    return { animation: 'none' }
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
