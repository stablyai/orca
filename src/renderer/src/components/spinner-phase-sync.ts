import type React from 'react'

/**
 * Anchor a CSS spinner's Web Animation timeline to the shared document epoch so
 * late mounts render at the exact same phase as every other on-screen spinner.
 *
 * Why animationstart-driven and not ref-time: a ref-time call forces a
 * synchronous style recalc per mount to sync a phase that animationstart fixes
 * one frame later anyway (measured: 24ms of blocking work per 200 mounts).
 */
export function syncSpinnerAnimationPhase(
  el: HTMLSpanElement | null,
  animationName: string
): void {
  if (el === null || typeof el.getAnimations !== 'function') {
    return
  }

  const animation = el
    .getAnimations()
    .find((candidate) => 'animationName' in candidate && candidate.animationName === animationName)
  if (animation !== undefined) {
    animation.startTime = 0
  }
}

/** Build an `onAnimationStart` handler that phase-syncs only the named animation. */
export function createSpinnerAnimationStartHandler(
  animationName: string
): (event: React.AnimationEvent<HTMLSpanElement>) => void {
  return (event) => {
    if (event.animationName === animationName) {
      syncSpinnerAnimationPhase(event.currentTarget, animationName)
    }
  }
}
