import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createNativeChatRevealScheduler,
  nativeChatRevealStepFrames
} from './native-chat-reveal-scheduler'

let clock = 0
let callbacks = new Map<number, (at: number) => void>()
let nextFrame = 0
let frameRequests = 0

beforeEach(() => {
  clock = 0
  callbacks = new Map()
  frameRequests = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: (at: number) => void) => {
    frameRequests += 1
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

it('sleeps through a long wait instead of asking for every frame', () => {
  const frames = nativeChatRevealStepFrames(60, 1 / 16)
  let steps = 0
  const step = (): void => {
    steps += 1
    frames.request(step)
    // Each step takes 200 ms to draw, so steps are spaced seconds apart.
    clock += 200
    frames.stepCost?.(200)
  }
  frames.request(step)
  // 10 s of a 60 Hz display.
  for (let frame = 0; frame < 600; frame++) {
    const at = clock + 1000 / 60
    vi.advanceTimersByTime(at - clock)
    clock = at
    const due = [...callbacks.values()]
    callbacks.clear()
    due.forEach((callback) => callback(at))
  }
  expect(steps).toBeGreaterThan(1)
  expect(frameRequests).toBeLessThan(100)
})

// Perf contract: streaming replies in one window share one clock, so their steps never land in the
// same frame and, together, keep to one busy share of the thread however many there are.
it('steps several replies one a frame within one shared busy share', () => {
  const scheduler = createNativeChatRevealScheduler(60, 1 / 4)
  const busy: number[] = []
  const stepsByFrame = new Map<number, number>()
  let frameAt = 0
  for (let reply = 0; reply < 4; reply++) {
    const frames = scheduler()
    const step = (): void => {
      stepsByFrame.set(frameAt, (stepsByFrame.get(frameAt) ?? 0) + 1)
      frames.request(step)
      // Each step takes 20 ms to draw.
      busy.push(20)
      clock += 20
      frames.stepCost?.(20)
    }
    frames.request(step)
  }
  const start = clock
  // 10 s of a 60 Hz display.
  for (let frame = 0; frame < 600; frame++) {
    const at = clock + 1000 / 60
    vi.advanceTimersByTime(at - clock)
    clock = at
    frameAt = frame
    const due = [...callbacks.values()]
    callbacks.clear()
    due.forEach((callback) => callback(at))
  }
  expect(Math.max(...stepsByFrame.values())).toBe(1)
  const share = busy.reduce((total, ms) => total + ms, 0) / (clock - start)
  expect(share).toBeLessThanOrEqual(0.26)
  expect(share).toBeGreaterThan(0.15)
})
