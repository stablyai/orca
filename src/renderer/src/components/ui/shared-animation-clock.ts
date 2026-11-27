import type React from 'react'

// Shared keyframes for every stepped spinner (main.css); one clock keeps their steps on the same frames.
const SPINNER_ANIMATION_NAME = 'agent-spinner-rotate'
// The stale-review shimmer (text-shimmer.css); unanchored rows each repaint on their own frames.
const SHIMMER_ANIMATION_NAME = 'tw-shimmer'
// The worker chip's dot grid (main.css); every chip's wave lands on the same beat.
const DOT_WAVE_ANIMATION_NAME = 'worker-dock-dot-wave'

// Anchor Web Animations only on animationstart for phase sync without recurring JS. Mount-time queries force style recalculation (~24ms/200 mounts).
function anchorToDocumentClock(event: React.AnimationEvent<HTMLElement>, name: string): void {
  if (event.animationName !== name) {
    return
  }
  const el = event.target
  if (!(el instanceof Element) || typeof el.getAnimations !== 'function') {
    return
  }
  const animation = el
    .getAnimations()
    .find((candidate) => 'animationName' in candidate && candidate.animationName === name)
  if (animation !== undefined) {
    animation.startTime = 0
  }
}

export function handleSpinnerAnimationStart(event: React.AnimationEvent<HTMLElement>): void {
  anchorToDocumentClock(event, SPINNER_ANIMATION_NAME)
}

export function handleShimmerAnimationStart(event: React.AnimationEvent<HTMLElement>): void {
  anchorToDocumentClock(event, SHIMMER_ANIMATION_NAME)
}

// Handled on the grid: the first (undelayed) cell's start anchors all nine at once, so a later cell
// never snaps to the shared phase when its own delayed start fires.
export function handleDotWaveAnimationStart(event: React.AnimationEvent<HTMLElement>): void {
  const grid = event.currentTarget
  if (event.animationName !== DOT_WAVE_ANIMATION_NAME || typeof grid.getAnimations !== 'function') {
    return
  }
  for (const animation of grid.getAnimations({ subtree: true })) {
    if (
      'animationName' in animation &&
      animation.animationName === DOT_WAVE_ANIMATION_NAME &&
      animation.startTime !== 0
    ) {
      animation.startTime = 0
    }
  }
}
