import type React from 'react'

// Shared keyframes for every stepped spinner (main.css); one clock keeps their steps on the same frames.
export const SPINNER_ANIMATION_NAME = 'agent-spinner-rotate'

// Anchor Web Animations only on animationstart for phase sync without recurring JS. Mount-time queries force style recalculation (~24ms/200 mounts).
export function handleSpinnerAnimationStart(event: React.AnimationEvent<HTMLElement>): void {
  if (event.animationName !== SPINNER_ANIMATION_NAME) {
    return
  }
  const el = event.currentTarget
  if (typeof el.getAnimations !== 'function') {
    return
  }
  const animation = el
    .getAnimations()
    .find(
      (candidate) =>
        'animationName' in candidate && candidate.animationName === SPINNER_ANIMATION_NAME
    )
  if (animation !== undefined) {
    animation.startTime = 0
  }
}
