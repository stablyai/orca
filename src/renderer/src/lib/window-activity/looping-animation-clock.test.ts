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
  it('steps spinners an eighth of a turn each time a label repaints, in step with each other', () => {
    const ring = fakeAnimation('agent-spinner-rotate')
    const slow = fakeAnimation('spin', 'paused', 2_000)
    const clock = harness([ring, slow])
    clock.labelRepainted()
    expect(ring.currentTime).toBe(125)
    expect(slow.currentTime).toBe(250)
    for (let i = 0; i < 7; i++) {
      clock.labelRepainted()
    }
    expect(ring.currentTime).toBe(0)
  })

  it('holds still while nothing else repaints', () => {
    const ring = fakeAnimation('agent-spinner-rotate')
    const clock = harness([ring])
    clock.loopStarted(ring)
    expect(ring.currentTime).toBe(0)
  })

  it('breathes a pulse over four steps', () => {
    const pulse = fakeAnimation('pulse', 'paused', 2_000)
    const clock = harness([pulse])
    const seen: (number | null)[] = []
    for (let i = 0; i < 4; i++) {
      clock.labelRepainted()
      seen.push(pulse.currentTime)
    }
    expect(seen).toEqual([500, 1_000, 1_500, 0])
  })

  it('puts a spinner that mounts mid-cycle on the shared step as it mounts', () => {
    const first = fakeAnimation('agent-spinner-rotate')
    const animations = [first]
    const clock = harness(animations)
    clock.labelRepainted()
    clock.labelRepainted()
    const late = fakeAnimation('agent-spinner-rotate')
    animations.push(late)
    clock.loopStarted(late)
    expect(late.currentTime).toBe(250)
    expect(first.currentTime).toBe(250)
  })

  it('pauses a loop that something set running', () => {
    const loader = fakeAnimation('spin', 'running')
    const clock = harness([loader])
    clock.loopStarted(loader)
    expect(loader.playState).toBe('paused')
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
