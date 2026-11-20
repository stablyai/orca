import { describe, expect, it } from 'vitest'
import {
  installLoopingAnimationClock,
  type LoopingAnimationClockDeps
} from './looping-animation-clock'

type FakeAnimation = {
  animationName: string
  playState: AnimationPlayState
  currentTime: number | null
  pause: () => void
  effect: { getComputedTiming: () => { duration: number } }
}

function fakeAnimation(
  animationName: string,
  playState: AnimationPlayState = 'paused',
  duration = 1_000
): FakeAnimation {
  const animation: FakeAnimation = {
    animationName,
    playState,
    currentTime: 0,
    pause: () => {
      animation.playState = 'paused'
    },
    effect: { getComputedTiming: () => ({ duration }) }
  }
  return animation
}

function harness(animations: FakeAnimation[]) {
  let repaint: (() => void) | null = null
  let start: ((started: FakeAnimation[]) => void) | null = null
  const deps: LoopingAnimationClockDeps = {
    getAnimations: () => animations,
    onLabelRepaint: (listener) => {
      repaint = listener
      return () => {
        repaint = null
      }
    },
    onLoopStart: (listener) => {
      start = listener
      return () => {
        start = null
      }
    }
  }
  const dispose = installLoopingAnimationClock(deps)
  return {
    dispose,
    labelRepainted: () => repaint?.(),
    loopStarted: (animation: FakeAnimation) => start?.([animation])
  }
}

describe('installLoopingAnimationClock', () => {
  it('moves paused spinners together on repaint and brings a new spinner to their phase', () => {
    const ring = fakeAnimation('agent-spinner-rotate')
    const slow = fakeAnimation('spin', 'paused', 2_000)
    const animations = [ring, slow]
    const clock = harness(animations)
    clock.labelRepainted()
    expect(ring.currentTime).toBeGreaterThan(0)
    expect(Number(slow.currentTime) / 2).toBe(ring.currentTime)

    const late = fakeAnimation('agent-spinner-rotate', 'running')
    animations.push(late)
    clock.loopStarted(late)
    expect(late.currentTime).toBe(ring.currentTime)
    expect(late.playState).toBe('paused')
  })

  it('leaves animations it does not know alone', () => {
    const other = fakeAnimation('collapsible-down', 'running')
    const clock = harness([other])
    clock.labelRepainted()
    expect(other.playState).toBe('running')
    expect(other.currentTime).toBe(0)
  })

  it('stops stepping when disposed', () => {
    const ring = fakeAnimation('agent-spinner-rotate')
    const clock = harness([ring])
    clock.dispose()
    clock.labelRepainted()
    expect(ring.currentTime).toBe(0)
  })
})
