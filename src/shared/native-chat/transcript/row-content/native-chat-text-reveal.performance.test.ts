import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeChatRevealStepFrames } from './native-chat-text-reveal'

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
