import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeChatRevealStepFrames } from './native-chat-text-reveal'

let clock = 0
let callbacks = new Map<number, (at: number) => void>()
let nextFrame = 0

beforeEach(() => {
  clock = 0
  callbacks = new Map()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: (at: number) => void) => {
    callbacks.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Runs a reveal that re-requests after every step, on frames `frameGaps` apart, and returns its steps. */
function stepTimes(frameGaps: (frame: number) => number, frames: number, render = 0): number[] {
  const clockFrames = nativeChatRevealStepFrames(60, 1 / 16)
  const steps: number[] = []
  const step = (): void => {
    steps.push(clock)
    clockFrames.request(step)
    // The step's render runs after its frame callback, so the next frame starts late.
    clock += render
  }
  clockFrames.request(step)
  for (let frame = 0; frame < frames; frame++) {
    const at = Math.max(clock, clock + frameGaps(frame))
    vi.advanceTimersByTime(at - clock)
    clock = at
    const due = [...callbacks.values()]
    callbacks.clear()
    due.forEach((callback) => callback(at))
  }
  return steps
}

const spacings = (steps: number[]): number[] =>
  steps.slice(1).map((at, index) => at - steps[index]!)

describe('the reveal clock on an idle thread', () => {
  for (const hz of [30, 50, 60, 120]) {
    it(`steps about every 60 ms at ${hz} Hz`, () => {
      const period = 1000 / hz
      const gaps = spacings(stepTimes(() => period, hz * 10))
      expect(Math.max(...gaps)).toBeLessThanOrEqual(60 + period + 0.01)
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60 - period / 2 - 0.01)
    })
  }

  it('keeps its pace after a lone fast double frame', () => {
    const gaps = spacings(stepTimes((frame) => (frame === 100 ? 1 : 1000 / 30), 600))
    expect(Math.max(...gaps.slice(5))).toBeLessThanOrEqual(60 + 1000 / 30 + 0.01)
  })
})

it('keeps a plain reply moving through one unrelated slow frame', () => {
  const gaps = spacings(stepTimes((frame) => (frame === 200 ? 400 : 1000 / 60), 600))
  // Only the step the hitch itself delayed waits longer; none after it backs off.
  expect(gaps.filter((gap) => gap > 100)).toHaveLength(1)
})

it('still spaces its steps out when each step is slow to draw', () => {
  const gaps = spacings(stepTimes(() => 1000 / 60, 600, 200))
  expect(Math.max(...gaps)).toBeGreaterThan(1000)
})
