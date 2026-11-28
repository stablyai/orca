import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { receiveNativeChatText, startNativeChatTextReveal } from './native-chat-text-reveal'
import { nativeChatRevealStepFrames } from './native-chat-reveal-scheduler'

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
  let rendering = false
  const step = (): void => {
    steps.push(clock)
    rendering = true
  }
  clockFrames.request(step)
  // Timers run on the same clock as the renders that move it.
  let timersAt = clock
  for (let frame = 0; frame < frames; frame++) {
    const at = Math.max(clock, clock + frameGaps(frame))
    clock = at
    vi.advanceTimersByTime(at - timersAt)
    timersAt = at
    const due = [...callbacks.values()]
    callbacks.clear()
    due.forEach((callback) => callback(at))
    // As on screen: the step renders, reports its cost, then asks for the next step.
    if (rendering) {
      rendering = false
      clock += render
      vi.advanceTimersByTime(render)
      timersAt = clock
      clockFrames.stepCost?.(render)
      clockFrames.request(step)
    }
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
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60 - 0.01)
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

it('waits out a slow step before the very next one', () => {
  const frames = nativeChatRevealStepFrames(60, 1 / 10)
  frames.stepCost?.(5)
  frames.stepCost?.(80)
  const steps = stepTimes(() => 1000 / 60, 120, 80, frames)
  // The median is already 80 ms, so the first gap is about 800 ms, not 60.
  expect(steps[1]! - steps[0]!).toBeGreaterThanOrEqual(800 - 1000 / 120 - 0.01)
})

it('counts its spacing from when its step ran, not from a frame that other work held up', () => {
  const frames = nativeChatRevealStepFrames(60, 1 / 10)
  const steps: number[] = []
  const step = (): void => {
    steps.push(clock)
    frames.request(step)
  }
  frames.request(step)
  const runFrame = (at: number, before = 0): void => {
    vi.advanceTimersByTime(at - clock)
    clock = at
    const due = [...callbacks.values()]
    callbacks.clear()
    // Other callbacks in this frame ran first and took `before` ms.
    clock += before
    due.forEach((callback) => callback(at))
  }
  for (let at = 1000 / 60; at < 200; at += 1000 / 60) {
    runFrame(at)
  }
  const held = steps.length
  runFrame(clock + 1000 / 60, 150)
  expect(steps.length).toBe(held + 1)
  const ranAt = steps.at(-1)!
  for (let frame = 0; frame < 3; frame++) {
    runFrame(clock + 1000 / 60)
  }
  // It ran 150 ms into its frame, so the next step waits about 60 ms from then.
  expect(steps.length).toBe(held + 1)
  expect(ranAt).toBeGreaterThan(0)
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

  it('remembers it was redrawn whole across a remount and replaced text', () => {
    const text = (length: number) => 'w'.repeat(length)
    const remembered = { source: text(1000), shown: 1000, arrivals: [], drawsWhole: true as const }
    expect(startNativeChatTextReveal(text(1200), true, remembered, true, 0).drawsWhole).toBe(true)
    expect(startNativeChatTextReveal(text(1000), true, remembered, true, 0).drawsWhole).toBe(true)
    expect(receiveNativeChatText(remembered, 'other', true, false, 0).drawsWhole).toBe(true)
    expect(receiveNativeChatText(remembered, text(1100), false, true, 0).drawsWhole).toBe(true)
  })
})
