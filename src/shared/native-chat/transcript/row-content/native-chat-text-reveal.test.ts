import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeChatRevealStepFrames,
  receiveNativeChatText,
  startNativeChatTextReveal
} from './native-chat-text-reveal'

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
function stepTimes(
  frameGaps: (frame: number) => number,
  frames: number,
  render = 0,
  clockFrames = nativeChatRevealStepFrames(60, 1 / 16)
): number[] {
  const steps: number[] = []
  const step = (): void => {
    steps.push(clock)
    clockFrames.request(step)
    // The step's render runs after its frame callback, so the next frame starts late.
    clock += render
    clockFrames.stepCost?.(render)
  }
  clockFrames.request(step)
  // Timers run on the same clock as the renders that move it.
  let timersAt = clock
  for (let frame = 0; frame < frames; frame++) {
    const at = Math.max(clock, clock + frameGaps(frame))
    vi.advanceTimersByTime(at - timersAt)
    timersAt = at
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

describe('a reply redrawn whole each step', () => {
  it('switches once its steps are slow, and stays switched', () => {
    const frames = nativeChatRevealStepFrames(60, 1 / 10)
    for (const ms of [20, 20, 150]) {
      frames.stepCost?.(ms)
    }
    expect(frames.redrawsWhole?.()).toBe(false)
    frames.stepCost?.(150)
    expect(frames.redrawsWhole?.()).toBe(true)
    // Cheap steps later in the same reply don't switch it back.
    for (const ms of [10, 10, 10]) {
      frames.stepCost?.(ms)
    }
    expect(frames.redrawsWhole?.()).toBe(true)
  })

  it('steps at a third of its time once redrawn whole, where an unswitched reply waits ten times its cost', () => {
    const switched = spacings(
      stepTimes(() => 1000 / 60, 600, 150, nativeChatRevealStepFrames(60, 1 / 10, 1 / 3))
    ).slice(5)
    expect(Math.min(...switched)).toBeGreaterThanOrEqual(450 - 1000 / 120 - 0.01)
    expect(Math.max(...switched)).toBeLessThanOrEqual(450 + 1000 / 60 + 0.01)
    const unswitched = spacings(
      stepTimes(() => 1000 / 60, 600, 90, nativeChatRevealStepFrames(60, 1 / 10, 1 / 3))
    ).slice(5)
    expect(Math.min(...unswitched)).toBeGreaterThanOrEqual(900 - 1000 / 120 - 0.01)
  })

  it('a clock told the reply was already redrawn whole uses the third from its first steps', () => {
    const frames = nativeChatRevealStepFrames(60, 1 / 10, 1 / 3)
    frames.drawWhole?.()
    expect(frames.redrawsWhole?.()).toBe(true)
    const gaps = spacings(stepTimes(() => 1000 / 60, 300, 150, frames)).slice(1)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(450 + 1000 / 60 + 0.01)
  })

  it('remembers it was redrawn whole across a remount and replaced text', () => {
    const text = (length: number) => 'w'.repeat(length)
    const remembered = { source: text(1000), shown: 1000, arrivals: [], drawsWhole: true as const }
    expect(startNativeChatTextReveal(text(1200), true, remembered, true, 0).drawsWhole).toBe(true)
    expect(startNativeChatTextReveal(text(1000), true, remembered, true, 0).drawsWhole).toBe(true)
    expect(receiveNativeChatText(remembered, 'other', true, false, 0).drawsWhole).toBe(true)
    expect(receiveNativeChatText(remembered, text(1100), false, true, 0).drawsWhole).toBe(true)
  })
})
